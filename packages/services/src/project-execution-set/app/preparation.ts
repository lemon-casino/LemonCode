import {
  executionSetPrepareRequestSchema,
  resolveWorkspaceKey,
  type ExecutionSetPrepareRequest,
  type ExecutionSetSnapshot,
} from "@lcode/shared";
import type { ExecutionSetPorts } from "./ports.js";
import { executionSetMemberScope, executionSetOwner } from "../domain/identity.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
export function createExecutionSetPreparation(
  ports: ExecutionSetPorts,
  save: (snapshot: ExecutionSetSnapshot) => Promise<ExecutionSetSnapshot>,
) {
  const { store, worktrees } = ports;
  async function continuePreparation(
    snapshot: ExecutionSetSnapshot,
  ): Promise<ExecutionSetSnapshot> {
    if (["archived", "archiving", "restoring"].includes(snapshot.status))
      throw new Error("Finish the execution set archive/restore operation before preparing");
    if (!snapshot.repositories.length) {
      let inspecting: (typeof snapshot.projectContext.members)[number] | undefined;
      try {
        const repositories = new Map<string, ExecutionSetSnapshot["repositories"][number]>();
        for (const member of snapshot.projectContext.members) {
          inspecting = member;
          const info = await worktrees.inspectOwnedRepository(
            executionSetMemberScope(snapshot, member.sourcePath),
          );
          // 中文依据：绝对 symlink/junction 可在新 checkout 中继续指向原库，不能只用词法前缀证明隔离。
          if (relative(info.canonicalPath, resolve(member.sourcePath)))
            throw new Error(
              `${member.sourcePath}: select the canonical source directory ${info.canonicalPath}`,
            );
          const suffix = relative(info.root, resolve(member.sourcePath));
          if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
            throw new Error(`${member.sourcePath}: member is outside its repository source`);
          let repository = repositories.get(info.commonDirectory);
          if (!repository) {
            const id = store.key(
              JSON.stringify([resolveWorkspaceKey(snapshot.origin), info.commonDirectory]),
            );
            const baseRef = snapshot.baseRefs?.[id] ?? snapshot.baseRefs?.[member.memberId];
            const source = snapshot.forkSource?.bindings.find(
              (binding) => binding.repositoryId === id,
            );
            if (snapshot.forkSource && !source)
              throw new Error(`${member.sourcePath}: fork source repository is missing`);
            const head = source
              ? (
                  await worktrees.inspectOwnedRepository({
                    workspacePath: source.workspacePath,
                    workspaceIdentity: source.workspaceIdentity,
                  })
                ).head
              : baseRef
                ? (
                    await worktrees.inspectOwnedRepository({
                      ...executionSetMemberScope(snapshot, member.sourcePath),
                      baseRef,
                    })
                  ).head
                : info.head;
            repository = {
              id,
              repositoryRoot: info.root,
              commonDirectory: info.commonDirectory,
              baseRef: head,
              memberIds: [],
              status: "planned",
            };
            repositories.set(info.commonDirectory, repository);
          }
          if (repository.repositoryRoot !== info.root)
            throw new Error(
              `${member.sourcePath}: members of one repository must use the same source checkout`,
            );
          const requestedBase =
            snapshot.baseRefs?.[repository.id] ?? snapshot.baseRefs?.[member.memberId];
          if (
            requestedBase &&
            (
              await worktrees.inspectOwnedRepository({
                ...executionSetMemberScope(snapshot, member.sourcePath),
                baseRef: requestedBase,
              })
            ).head !== repository.baseRef
          )
            throw new Error(
              `${member.sourcePath}: members of one repository must use one base commit`,
            );
          if (suffix && !snapshot.forkSource)
            await worktrees.inspectOwnedRepository({
              ...executionSetMemberScope(snapshot, member.sourcePath),
              baseRef: repository.baseRef,
              requireDirectoryAtRef: true,
            });
          repository.memberIds.push(member.memberId);
        }
        const known = new Set(
          [...repositories.values()].flatMap((repository) => [
            repository.id,
            ...repository.memberIds,
          ]),
        );
        if (Object.keys(snapshot.baseRefs ?? {}).some((key) => !known.has(key)))
          throw new Error("A requested base ref does not belong to this execution set");
        snapshot = await save({
          ...snapshot,
          repositories: [...repositories.values()].sort((a, b) => a.id.localeCompare(b.id)),
          status: "preparing",
          error: undefined,
          preflightFailure: undefined,
        });
      } catch (error) {
        return save({
          ...snapshot,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          preflightFailure: inspecting
            ? {
                memberId: inspecting.memberId,
                sourcePath: inspecting.sourcePath,
                error: error instanceof Error ? error.message : String(error),
              }
            : undefined,
        });
      }
    }
    for (const repository of snapshot.repositories) {
      const ownerRef = executionSetOwner(snapshot.id, repository.id);
      const members = snapshot.projectContext.members.filter((member) =>
        repository.memberIds.includes(member.memberId),
      );
      const scope = executionSetMemberScope(snapshot, repository.repositoryRoot);
      try {
        const info = await worktrees.inspectOwnedRepository(scope);
        if (info.commonDirectory !== repository.commonDirectory)
          throw new Error("Repository identity changed after planning");
        if (repository.status !== "ready") {
          repository.status = "preparing";
          repository.error = undefined;
          snapshot = await save({ ...snapshot, status: "preparing" });
        }
        const binding = await worktrees.prepareOwnedBinding({
          ...scope,
          ownerRef,
          requestId: snapshot.requestId,
          projectId: snapshot.projectContext.projectId,
          taskName: snapshot.preparationName,
          baseRef: repository.baseRef,
          ...(snapshot.forkSource
            ? {
                forkSource: (() => {
                  const source = snapshot.forkSource!.bindings.find(
                    (binding) => binding.repositoryId === repository.id,
                  )!;
                  return {
                    workspacePath: source.workspacePath,
                    workspaceIdentity: source.workspaceIdentity,
                  };
                })(),
              }
            : {}),
          sourceFolderPaths: members.map((member) => member.sourcePath),
        });
        if (binding.status !== "ready")
          throw new Error(binding.error ?? `Worktree is ${binding.status}`);
        repository.bindingId = binding.id;
        repository.status = "ready";
        repository.error = undefined;
        snapshot = await save(snapshot);
      } catch (error) {
        repository.status = "failed";
        repository.error = error instanceof Error ? error.message : String(error);
        snapshot = await save({
          ...snapshot,
          status: "failed",
          error: `${repository.repositoryRoot}: ${repository.error}`,
        });
        return snapshot;
      }
    }
    return save({ ...snapshot, status: "ready", error: undefined });
  }
  return {
    continuePreparation,
    async prepare(raw: ExecutionSetPrepareRequest) {
      const input = executionSetPrepareRequestSchema.parse(raw);
      const id = store.key(
        JSON.stringify([resolveWorkspaceKey(input.projectContext.origin), input.operationId]),
      );
      const fingerprint = store.key(JSON.stringify(input));
      return store.lock(id, async () => {
        let snapshot = await store.read(id);
        if (snapshot && snapshot.fingerprint !== fingerprint)
          throw new Error("Execution set operationId reused with different content");
        if (!snapshot) {
          const now = ports.now();
          snapshot = await save({
            version: 1,
            id,
            name: input.name,
            preparationName: input.name,
            revision: 0,
            requestId: input.operationId,
            fingerprint,
            origin: input.projectContext.origin,
            projectContext: input.projectContext,
            baseRefs: input.baseRefs,
            forkSource: input.forkSource,
            status: "preflighting",
            repositories: [],
            sessions: [],
            createdAt: now,
            updatedAt: now,
          });
        }
        return continuePreparation(snapshot);
      });
    },
  };
}
