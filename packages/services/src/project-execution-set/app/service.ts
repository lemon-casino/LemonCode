import { z } from "zod";
import {
  executionSetScopeSchema,
  resolveWorkspaceKey,
  type ExecutionSetSnapshot,
} from "@lcode/shared";
import type { ProjectExecutionSetHostService } from "../contract.js";
import type { ExecutionSetPorts } from "./ports.js";
import {
  assertExecutionSetScope,
  executionSetOwner,
  executionSetMemberScope,
} from "../domain/identity.js";
import { createExecutionSetPreparation } from "./preparation.js";
import { acquireExecutionSetPermits, resolveExecutionSetContext } from "./execution.js";
import { archiveExecutionSet } from "./archive.js";
import { restoreExecutionSet } from "./restoration.js";
const text = z.string().trim().min(1).max(32768);
const target = executionSetScopeSchema.extend({
  executionSetId: z.string().regex(/^[a-f0-9]{32}$/),
});
const sessionTarget = target.extend({ sessionId: text });
export function createExecutionSetApplication(
  ports: ExecutionSetPorts,
): Omit<ProjectExecutionSetHostService, "onDidChange"> {
  const { store, worktrees } = ports;
  const save = async (snapshot: ExecutionSetSnapshot) => {
    const next = { ...snapshot, revision: snapshot.revision + 1, updatedAt: ports.now() };
    await store.write(next);
    ports.changed(structuredClone(next));
    return next;
  };
  const requireSet = async (request: z.infer<typeof target>) => {
    const snapshot = await store.read(request.executionSetId);
    if (!snapshot) throw new Error("Execution set not found");
    assertExecutionSetScope(snapshot, request);
    return snapshot;
  };
  const preparation = createExecutionSetPreparation(ports, save);
  return {
    capabilities: async () => ({ protocolVersion: 1, multiRepository: true }),
    prepare: preparation.prepare,
    async getPreparation(raw) {
      const input = executionSetScopeSchema.extend({ operationId: text }).parse(raw);
      const snapshot = await store.read(
        store.key(JSON.stringify([resolveWorkspaceKey(input), input.operationId])),
      );
      if (snapshot) assertExecutionSetScope(snapshot, input);
      return snapshot;
    },
    async get(raw) {
      const input = target.parse(raw);
      const snapshot = await store.read(input.executionSetId);
      if (snapshot) assertExecutionSetScope(snapshot, input);
      return snapshot;
    },
    async list(raw) {
      const scope = executionSetScopeSchema.parse(raw);
      return (await store.list()).filter((snapshot) => {
        try {
          assertExecutionSetScope(snapshot, scope);
          return true;
        } catch {
          return false;
        }
      });
    },
    async bindings(raw) {
      const snapshot = await requireSet(target.parse(raw));
      return Promise.all(
        snapshot.repositories.map(async (repository) => {
          try {
            const binding = await worktrees.getOwnedBinding({
              ...executionSetMemberScope(snapshot, repository.repositoryRoot),
              ownerRef: executionSetOwner(snapshot.id, repository.id),
            });
            const operation = binding?.latestIntegrationId
              ? await worktrees.getIntegration({ operationId: binding.latestIntegrationId })
              : null;
            // 中文依据：收据必须属于实际成员 binding，禁止拼接其它仓库结果或在刷新时重发发布。
            if (operation && operation.bindingId !== binding!.id)
              throw new Error("Integration receipt belongs to a different binding");
            return {
              repositoryId: repository.id,
              binding,
              ...(operation
                ? {
                    integration: {
                      operationId: operation.id,
                      bindingId: operation.bindingId,
                      status: operation.status,
                      sourceHead: operation.sourceHead,
                      targetHead: operation.targetHead,
                      targetBranch: operation.targetBranch,
                      candidateHead: operation.candidateHead,
                      updatedAt: operation.updatedAt,
                      error: operation.error,
                    },
                  }
                : {}),
            };
          } catch (error) {
            return {
              repositoryId: repository.id,
              binding: null,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
    },
    async retry(raw) {
      const input = target.extend({ operationId: text }).parse(raw);
      return store.lock(input.executionSetId, async () => {
        const snapshot = await requireSet(input);
        if (snapshot.requestId !== input.operationId)
          throw new Error("Retry must use the original preparation operationId");
        return preparation.continuePreparation(snapshot);
      });
    },
    async rename(raw) {
      const input = target
        .extend({
          name: text.max(120),
          expectedRevision: z.number().int().nonnegative(),
          operationId: text,
        })
        .parse(raw);
      return store.lock(input.executionSetId, async () => {
        const snapshot = await requireSet(input);
        if (snapshot.metadataOperation?.operationId === input.operationId) {
          if (snapshot.metadataOperation.name !== input.name)
            throw new Error("Rename operationId reused");
          return snapshot;
        }
        if (snapshot.revision !== input.expectedRevision)
          throw new Error("Execution set was changed in another window");
        return save({
          ...snapshot,
          name: input.name,
          metadataOperation: { operationId: input.operationId, name: input.name },
        });
      });
    },
    async attachSession(raw) {
      const input = sessionTarget.extend({ operationId: text }).parse(raw);
      return store.lock(input.executionSetId, async () => {
        let snapshot = await requireSet(input);
        const resolved = await resolveExecutionSetContext(ports, snapshot);
        if (
          snapshot.sessions.find((session) => session.sessionId === input.sessionId)?.status ===
          "attached"
        )
          return resolved.reference;
        if (!snapshot.sessions.some((session) => session.sessionId === input.sessionId))
          snapshot = await save({
            ...snapshot,
            sessions: [
              ...snapshot.sessions,
              { sessionId: input.sessionId, operationId: input.operationId, status: "attaching" },
            ],
          });
        else
          snapshot = await save({
            ...snapshot,
            sessions: snapshot.sessions.map((session) =>
              session.sessionId === input.sessionId ? { ...session, status: "attaching" } : session,
            ),
          });
        for (const repository of snapshot.repositories)
          await worktrees.attachBindingConsumer({
            bindingId: repository.bindingId!,
            owner: { kind: "session", sessionId: input.sessionId },
            operationId: input.operationId,
          });
        await save({
          ...snapshot,
          sessions: snapshot.sessions.map((session) =>
            session.sessionId === input.sessionId ? { ...session, status: "attached" } : session,
          ),
        });
        return resolved.reference;
      });
    },
    async resolveContext(raw) {
      const input = sessionTarget.parse(raw);
      const snapshot = await requireSet(input);
      if (
        !snapshot.sessions.some(
          (session) => session.sessionId === input.sessionId && session.status === "attached",
        )
      )
        throw new Error("Session is not attached to this execution set");
      return resolveExecutionSetContext(ports, snapshot);
    },
    async acquireExecution(raw, permits = worktrees) {
      const input = sessionTarget.extend({ ownerId: text }).parse(raw);
      const snapshot = await requireSet(input);
      if (
        !snapshot.sessions.some(
          (session) => session.sessionId === input.sessionId && session.status === "attached",
        )
      )
        throw new Error("Session is not attached to this execution set");
      return acquireExecutionSetPermits(ports, snapshot, input.ownerId, permits);
    },
    async archive(raw) {
      const input = target
        .extend({ operationId: text, acknowledgeIgnoredFiles: z.boolean().optional() })
        .parse(raw);
      return store.lock(input.executionSetId, async () =>
        archiveExecutionSet(
          ports,
          await requireSet(input),
          input.operationId,
          save,
          input.acknowledgeIgnoredFiles,
        ),
      );
    },
    async restore(raw) {
      const input = target.extend({ operationId: text }).parse(raw);
      return store.lock(input.executionSetId, async () =>
        restoreExecutionSet(ports, await requireSet(input), input.operationId, save),
      );
    },
  };
}
