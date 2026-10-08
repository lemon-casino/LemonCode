import type { WorktreeCommandRunner, WorktreeIntegration } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { cleanupTemporaryTarget } from "./temporaryTarget.js";
import { validateIntegrationCandidate } from "./validation.js";
import { assertCandidateEvidence } from "./candidateEvidence.js";

export function createWorktreePublication(
  context: WorktreeContext,
  options: {
    coordinator: CheckoutCoordinator;
    read(id: string): Promise<WorktreeIntegration>;
    save(operation: WorktreeIntegration): Promise<WorktreeIntegration>;
    validate: WorktreeCommandRunner;
  },
) {
  const { git, store } = context;
  async function assertTargetCanAdvance(path: string, head: string, candidate: string) {
    // 先刷新 stat 缓存再由原生 Git 只读预检索引和覆盖风险，不拦截无关工作文件。
    await git.command(path, ["status", "--porcelain", "--untracked-files=all"]);
    const result = await git.run({
      cwd: path,
      args: ["read-tree", "--dry-run", "-m", "-u", head, candidate],
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
      throw new Error(
        `Target checkout cannot be updated without overwriting local changes.\n${result.stderr.trim()}`,
      );
  }
  async function repositoryPath(operation: WorktreeIntegration) {
    return (
      operation.repositoryPath ??
      (await store.readBinding(operation.bindingId))?.repositoryRoot ??
      operation.targetPath
    );
  }
  async function isPublished(operation: WorktreeIntegration) {
    const repository = await repositoryPath(operation);
    const target = await git.resolveTarget(repository, operation.targetBranch);
    const included = await git.run({
      cwd: repository,
      args: ["merge-base", "--is-ancestor", operation.candidateHead!, target.head],
    });
    if (included.exitCode !== 0 && included.exitCode !== 1)
      throw new Error("Target publication needs reconciliation");
    return included.exitCode === 0;
  }
  async function finish(value: WorktreeIntegration) {
    let operation = await options.save({ ...value, status: "published", error: undefined });
    if (operation.targetTemporary && (await store.exists(operation.targetPath))) {
      try {
        await cleanupTemporaryTarget(context, operation);
      } catch (error) {
        operation = await options.save({
          ...operation,
          error: `Merge succeeded; temporary target cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return operation;
  }
  return async function publishIntegration(params: {
    operationId: string;
    approvedCandidateHead: string;
    skipValidation?: boolean;
  }) {
    return store.lock(params.operationId, async () => {
      let operation = await options.read(params.operationId);
      if (operation.status === "up-to-date") return operation;
      if (operation.status === "cancelled")
        throw new Error("Integration was cancelled; create a new reviewed operation");
      if (!operation.candidateHead || operation.candidateHead !== params.approvedCandidateHead)
        throw new Error("Exact integration candidate must be reviewed before publication");
      if (operation.targetTemporary) {
        await store.assertManagedPath(operation.targetPath);
        if (
          operation.targetPath !==
            store.checkout(store.key(`integration-target:${operation.id}`)) ||
          !operation.repositoryPath
        )
          throw new Error("Temporary target ownership does not match its record");
      }
      // 发布已发生时只对账目标 ref，不触碰候选目录、失效环境或重放验证命令。
      if (["publishing", "published"].includes(operation.status)) {
        if (await isPublished(operation)) {
          if (!operation.targetTemporary || !(await store.exists(operation.targetPath)))
            return options.save({ ...operation, status: "published", error: undefined });
          const cleanupLease = await options.coordinator.acquire({
            workspacePath: operation.targetPath,
            ownerId: `publish:${operation.id}`,
          });
          try {
            return await finish(operation);
          } finally {
            await options.coordinator.release(cleanupLease);
          }
        }
        if (operation.status === "published")
          throw new Error("Published target ancestry changed; manual reconciliation is required");
      }
      if (operation.targetTemporary && !(await store.exists(operation.targetPath)))
        throw new Error("Temporary target is missing before publication");
      const lease = await options.coordinator.acquire({
        workspacePath: operation.targetPath,
        ownerId: `publish:${operation.id}`,
      });
      let candidateLease: Awaited<ReturnType<CheckoutCoordinator["acquire"]>> | undefined;
      try {
        // 原请求可能在等待 checkout 期间已经生效，先对账再申请候选 writer。
        operation = await options.read(operation.id);
        if (operation.status === "publishing" && (await isPublished(operation)))
          return await finish(operation);
        candidateLease = await options.coordinator.acquire({
          workspacePath: operation.checkoutPath,
          ownerId: `publish-candidate:${operation.id}`,
        });
        const target = await git.inspect(operation.targetPath);
        if (
          target.branch !== operation.targetBranch &&
          !(operation.targetTemporary && !target.branch)
        )
          throw new Error("Target branch changed after integration review");
        await git.assertIdle(operation.targetPath);
        const selected = await git.resolveTarget(
          await repositoryPath(operation),
          operation.targetBranch,
        );
        if (selected.path && selected.path !== operation.targetPath)
          throw new Error("Target checkout changed; create and review a new integration");
        if (selected.head !== operation.targetHead || target.head !== operation.targetHead) {
          await options.save({
            ...operation,
            status: "failed",
            candidateEvidence: undefined,
            error: "Target HEAD changed; create and review a new integration",
          });
          throw new Error("Target HEAD changed; create and review a new integration");
        }
        await assertTargetCanAdvance(operation.targetPath, target.head, operation.candidateHead!);
        await git.assertIdle(operation.checkoutPath);
        if (
          await git.command(operation.checkoutPath, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ])
        )
          throw new Error("Integration checkout has uncommitted changes");
        if (
          (await git.command(operation.checkoutPath, ["rev-parse", "HEAD"])) !==
          operation.candidateHead
        )
          throw new Error("Integration candidate changed after review");
        if (!["ready", "publishing"].includes(operation.status)) {
          if (!["awaiting-review", "validation-failed"].includes(operation.status))
            throw new Error("Integration is not ready for candidate publication");
          operation = await validateIntegrationCandidate(
            context,
            operation,
            options.validate,
            candidateLease,
            params.skipValidation === true,
          );
        }
        if (!["ready", "publishing"].includes(operation.status)) return operation;
        // 旧 ready 没有新收据不能自动重验；publishing 重试也只使用原收据。
        try {
          await assertCandidateEvidence(context, operation);
        } catch (error) {
          await options.save({
            ...operation,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const checked = await git.inspect(operation.targetPath);
        const selectedAfter = await git.resolveTarget(
          await repositoryPath(operation),
          operation.targetBranch,
        );
        if (
          (selectedAfter.path && selectedAfter.path !== operation.targetPath) ||
          checked.head !== operation.targetHead ||
          selectedAfter.head !== operation.targetHead ||
          (checked.branch !== operation.targetBranch &&
            !(operation.targetTemporary && !checked.branch))
        )
          throw new Error("Target changed during validation");
        await assertTargetCanAdvance(
          operation.targetPath,
          checked.head,
          params.approvedCandidateHead,
        );
        operation = await options.save({ ...operation, status: "publishing" });
        await context.fault("publish.before-merge");
        if (operation.targetTemporary && !checked.branch)
          await git.command(operation.targetPath, ["switch", operation.targetBranch]);
        await git.command(operation.targetPath, [
          "merge",
          "--ff-only",
          params.approvedCandidateHead,
        ]);
        await context.fault("publish.after-merge");
        if (!(await isPublished(operation)))
          throw new Error("Target publication needs reconciliation");
        return await finish(operation);
      } finally {
        if (candidateLease) await options.coordinator.release(candidateLease);
        await options.coordinator.release(lease);
      }
    });
  };
}
