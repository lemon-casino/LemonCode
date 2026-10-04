import type { WorktreeIntegrateRequest, WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import { cleanupTemporaryTarget } from "./temporaryTarget.js";
import { commitIntegrationSource } from "./sourceCommit.js";
import { validateIntegrationCandidate } from "./validation.js";

export function createWorktreeIntegration(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  validate: (checkout: string, command: string) => Promise<{ exitCode: number; output: string }>,
) {
  const { git, store } = context;
  async function read(id: string) {
    const operation = await store.readOperation(id);
    if (!operation) throw new Error("Integration operation not found");
    await store.assertManagedPath(operation.checkoutPath);
    if (operation.checkoutPath !== store.checkout(operation.id))
      throw new Error("Integration checkout path does not match its record");
    return operation;
  }
  async function save(operation: WorktreeIntegration) {
    const value = { ...operation, updatedAt: new Date().toISOString() };
    await store.saveOperation(value);
    return value;
  }
  async function inspect(operation: WorktreeIntegration) {
    const conflictPaths = (
      await git.command(operation.checkoutPath, ["diff", "--name-only", "--diff-filter=U", "-z"])
    )
      .split("\0")
      .filter(Boolean);
    if (conflictPaths.length) return save({ ...operation, status: "conflicted", conflictPaths });
    const candidateHead = await git.command(operation.checkoutPath, ["rev-parse", "HEAD"]);
    for (const ancestor of [operation.targetHead, operation.sourceHead]) {
      const result = await git.run({
        cwd: operation.checkoutPath,
        args: ["merge-base", "--is-ancestor", ancestor, candidateHead],
      });
      if (result.exitCode !== 0)
        throw new Error("Integration candidate must retain both source and target history");
    }
    if (
      await git.command(operation.checkoutPath, ["status", "--porcelain", "--untracked-files=all"])
    )
      throw new Error("Commit all integration changes before review");
    const diff = await git.command(operation.checkoutPath, [
      "diff",
      operation.targetHead,
      candidateHead,
      "--",
    ]);
    const validationCommands =
      operation.validationSource && operation.validationSource !== "explicit"
        ? await context.detectValidation(operation.checkoutPath)
        : operation.validationCommands;
    return save({
      ...operation,
      validationCommands,
      validationSource:
        !operation.validationSource || operation.validationSource === "explicit"
          ? "explicit"
          : validationCommands.length
            ? "detected"
            : "none",
      status: "awaiting-review",
      candidateHead,
      conflictPaths: [],
      diff,
      error: undefined,
    });
  }
  async function integrate(params: WorktreeIntegrateRequest) {
    if (!params.requestId.trim() || !/^[a-f0-9]{40,64}$/.test(params.expectedSourceHead))
      throw new Error("Integration requires a request ID and exact source commit");
    const id = store.key(`integration:${params.bindingId}:${params.requestId}`);
    return store.lock(id, async () => {
      let operation = await store.readOperation(id);
      if (
        operation &&
        (operation.bindingId !== params.bindingId ||
          (operation.initialSourceHead ?? operation.sourceHead) !== params.expectedSourceHead ||
          JSON.stringify(operation.sourceCommits ?? []) !==
            JSON.stringify(params.sourceCommits ?? []) ||
          operation.targetBranch !== params.targetBranch)
      )
        throw new Error("Integration request ID cannot be reused with different inputs");
      if (
        operation &&
        !["preparing", "committing-source", "source-commit-failed"].includes(operation.status)
      )
        return operation;
      const binding = await store.readBinding(params.bindingId);
      if (!binding || binding.status !== "ready")
        throw new Error("Worktree must be ready before integration");
      if (!operation) {
        await store.assertManagedPath(binding.checkoutPath);
        const source = await git.inspect(binding.checkoutPath);
        if (
          source.head !== params.expectedSourceHead ||
          source.commonDirectory !== binding.commonDirectory ||
          source.branch !== binding.branch
        )
          throw new Error("Task source HEAD or worktree ownership changed");
        if (params.targetBranch === binding.branch)
          throw new Error("Integration source cannot target itself");
        const target = await git.resolveTarget(binding.repositoryRoot, params.targetBranch);
        // 根因：原实现把目标分支等同于原目录 HEAD；按真实注册解析，未检出目标不切换原项目。
        const targetPath = target.path ?? store.checkout(store.key(`integration-target:${id}`));
        const now = new Date().toISOString();
        operation = {
          id,
          bindingId: binding.id,
          requestId: params.requestId,
          sourceHead: params.expectedSourceHead,
          initialSourceHead: params.expectedSourceHead,
          ...(params.sourceCommits?.length
            ? { sourceCommits: params.sourceCommits, sourceReceipts: [] }
            : {}),
          targetHead: target.head,
          targetBranch: params.targetBranch,
          targetPath,
          repositoryPath: binding.repositoryRoot,
          ...(target.path ? {} : { targetTemporary: true }),
          checkoutPath: store.checkout(id),
          status: params.sourceCommits?.length ? "committing-source" : "preparing",
          conflictPaths: [],
          validationCommands: params.validationCommands ?? [],
          validationSource: params.validationCommands ? "explicit" : "detected",
          validationResults: [],
          createdAt: now,
          updatedAt: now,
          mergeBase: await git.command(binding.repositoryRoot, [
            "merge-base",
            target.head,
            source.head,
          ]),
        };
        await store.saveOperation(operation);
        await context.fault("integrate.after-record");
      }
      // operation 先落盘、binding 后关联；原请求重试必须补齐关联，不能留下不可见的 pending 集成。
      await store.lock(binding.id, async () => {
        const current = await store.readBinding(binding.id);
        if (!current || current.status !== "ready")
          throw new Error("Worktree changed before integration admission");
        if (current.latestIntegrationId && current.latestIntegrationId !== id) {
          const pending = await store.readOperation(current.latestIntegrationId);
          if (
            pending &&
            !["published", "failed", "cancelled", "source-commit-failed"].includes(pending.status)
          )
            throw new Error("Finish the existing integration before starting another");
        }
        await store.saveBinding({
          ...current,
          latestIntegrationId: id,
          updatedAt: new Date().toISOString(),
        });
      });
      if (["committing-source", "source-commit-failed"].includes(operation.status)) {
        operation = await commitIntegrationSource(context, coordinator, binding, operation);
        if (operation.status === "source-commit-failed") return operation;
      }
      if (operation.targetTemporary) {
        await store.assertManagedPath(operation.targetPath);
        if (!(await git.registered(binding.repositoryRoot, operation.targetPath))) {
          if (await store.exists(operation.targetPath))
            throw new Error("Temporary target destination is occupied");
          await git.command(binding.repositoryRoot, [
            "worktree",
            "add",
            "--detach",
            operation.targetPath,
            operation.targetHead,
          ]);
        }
      }
      await store.assertManagedPath(operation.checkoutPath);
      if (!(await git.registered(binding.repositoryRoot, operation.checkoutPath))) {
        if (await store.exists(operation.checkoutPath))
          throw new Error("Integration checkout destination is occupied");
        await git.command(binding.repositoryRoot, [
          "worktree",
          "add",
          "--detach",
          operation.checkoutPath,
          operation.targetHead,
        ]);
      }
      const candidateLease = await coordinator.acquire({
        workspacePath: operation.checkoutPath,
        ownerId: `integrate:${id}`,
      });
      try {
        const existingMerge = await git.run({
          cwd: operation.checkoutPath,
          args: ["rev-parse", "--verify", "MERGE_HEAD"],
        });
        if (existingMerge.exitCode !== 0) {
          const merge = await git.run({
            cwd: operation.checkoutPath,
            args: ["merge", "--no-ff", "--no-edit", operation.sourceHead],
          });
          await context.fault("integrate.after-merge");
          if (merge.exitCode !== 0) {
            const conflicts = (
              await git.command(operation.checkoutPath, [
                "diff",
                "--name-only",
                "--diff-filter=U",
                "-z",
              ])
            )
              .split("\0")
              .filter(Boolean);
            if (!conflicts.length)
              return save({
                ...operation,
                status: "failed",
                error: merge.stderr.trim() || "Native merge failed",
              });
          }
        }
        return inspect(operation);
      } finally {
        await coordinator.release(candidateLease);
      }
    });
  }
  async function continueIntegration(params: {
    operationId: string;
    cancel?: boolean;
    approvedCandidateHead?: string;
    validationCommands?: string[];
  }) {
    const original = await read(params.operationId);
    if (original.status === "published" && !params.cancel) return original;
    return store.lock(params.operationId, async () => {
      let operation = await read(params.operationId);
      if (params.cancel) {
        if (["publishing", "published"].includes(operation.status))
          throw new Error("Publication cannot be cancelled or rolled back");
        operation = await save({ ...operation, status: "cancelled", error: undefined });
        if (operation.targetTemporary && (await store.exists(operation.targetPath))) {
          const lease = await coordinator.acquire({
            workspacePath: operation.targetPath,
            ownerId: `cancel-target:${operation.id}`,
          });
          try {
            await cleanupTemporaryTarget(context, operation);
          } catch (error) {
            return save({
              ...operation,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            await coordinator.release(lease);
          }
        }
        return operation;
      }
      if (operation.status === "published") return operation;
      const lease = await coordinator.acquire({
        workspacePath: operation.checkoutPath,
        ownerId: `continue:${original.id}`,
      });
      try {
        if (
          [
            "publishing",
            "failed",
            "cancelled",
            "source-commit-failed",
            "committing-source",
            "preparing",
          ].includes(operation.status)
        )
          throw new Error("Integration is not ready for candidate review");
        if (params.validationCommands)
          operation = {
            ...operation,
            validationCommands: params.validationCommands,
            validationSource: "explicit",
          };
        const conflicts = await git.command(operation.checkoutPath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        if (conflicts) return inspect(operation);
        const merge = await git.run({
          cwd: operation.checkoutPath,
          args: ["rev-parse", "--verify", "MERGE_HEAD"],
        });
        if (merge.exitCode === 0)
          await git.command(operation.checkoutPath, ["commit", "--no-edit"]);
        operation = await inspect(operation);
        if (!params.approvedCandidateHead) return operation;
        if (operation.candidateHead !== params.approvedCandidateHead)
          throw new Error("Integration candidate changed; review the exact new commit");
        return validateIntegrationCandidate(context, operation, validate);
      } finally {
        await coordinator.release(lease);
      }
    });
  }
  return { integrate, continueIntegration, read, save, inspect };
}
