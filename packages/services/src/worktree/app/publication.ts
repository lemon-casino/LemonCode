import type { WorktreeIntegration } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
import { cleanupTemporaryTarget } from "./temporaryTarget.js";
import { validateIntegrationCandidate } from "./validation.js";

export function createWorktreePublication(
  context: WorktreeContext,
  options: {
    coordinator: CheckoutCoordinator;
    read(id: string): Promise<WorktreeIntegration>;
    save(operation: WorktreeIntegration): Promise<WorktreeIntegration>;
    validate(checkout: string, command: string): Promise<{ exitCode: number; output: string }>;
  },
) {
  const { git, store } = context;
  async function assertTargetCanAdvance(path: string, head: string, candidate: string) {
    // status 只刷新干净文件的 stat 缓存，不改变暂存内容；恢复原文后直接 dry-run 会误判缓存未更新。
    await git.command(path, ["status", "--porcelain", "--untracked-files=all"]);
    // 全目录 dirty 会误拦截无关改动；让原生 Git 预检查实际索引和覆盖风险，dry-run 不写文件或 index。
    const result = await git.run({
      cwd: path,
      args: ["read-tree", "--dry-run", "-m", "-u", head, candidate],
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(
        `Target checkout cannot be updated without overwriting local changes.\n${result.stderr.trim()}`,
      );
    }
  }
  return async function publishIntegration(params: {
    operationId: string;
    approvedCandidateHead: string;
  }) {
    const original = await options.read(params.operationId);
    return store.lock(original.id, async () => {
      const reconciled = await options.read(original.id);
      if (reconciled.candidateHead !== params.approvedCandidateHead)
        throw new Error("Exact integration candidate must be reviewed before publication");
      if (reconciled.targetTemporary) {
        await store.assertManagedPath(reconciled.targetPath);
        if (
          reconciled.targetPath !==
            store.checkout(store.key(`integration-target:${reconciled.id}`)) ||
          !reconciled.repositoryPath
        )
          throw new Error("Temporary target ownership does not match its record");
        // 响应丢失时临时目录可能已清理；依据目标 ref 对账，不能重放合并或创建空目录。
        if (!(await store.exists(reconciled.targetPath))) {
          if (!["publishing", "published"].includes(reconciled.status))
            throw new Error("Temporary target is missing before publication");
          if (reconciled.status === "published") return reconciled;
          const target = await git.resolveTarget(
            reconciled.repositoryPath,
            reconciled.targetBranch,
          );
          const included = await git.run({
            cwd: reconciled.repositoryPath,
            args: ["merge-base", "--is-ancestor", params.approvedCandidateHead, target.head],
          });
          if (included.exitCode !== 0) throw new Error("Target publication needs reconciliation");
          return options.save({ ...reconciled, status: "published", error: undefined });
        }
      } else if (reconciled.status === "published") return reconciled;
      const lease = await options.coordinator.acquire({
        workspacePath: original.targetPath,
        ownerId: `publish:${original.id}`,
      });
      let candidateLease: Awaited<ReturnType<CheckoutCoordinator["acquire"]>> | undefined;
      try {
        candidateLease = await options.coordinator.acquire({
          workspacePath: original.checkoutPath,
          ownerId: `publish-candidate:${original.id}`,
        });
        let operation = await options.read(original.id);
        if (operation.status === "cancelled")
          throw new Error("Integration was cancelled; create a new reviewed operation");
        if (!operation.candidateHead || operation.candidateHead !== params.approvedCandidateHead)
          throw new Error("Exact integration candidate must be reviewed before publication");
        const target = await git.inspect(operation.targetPath);
        if (
          target.branch !== operation.targetBranch &&
          !(operation.targetTemporary && !target.branch)
        )
          throw new Error("Target branch changed after integration review");
        const finish = async () => {
          operation = await options.save({ ...operation, status: "published", error: undefined });
          if (operation.targetTemporary) {
            try {
              // 只清理无改动的已确认目标，不强制移除；失败不抹掉合并成功事实。
              await cleanupTemporaryTarget(context, operation);
            } catch (error) {
              operation = await options.save({
                ...operation,
                error: `Merge succeeded; temporary target cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
          return operation;
        };
        if (operation.status === "published") return finish();
        await git.assertIdle(operation.targetPath);
        const selected = await git.resolveTarget(
          operation.repositoryPath ?? operation.targetPath,
          operation.targetBranch,
        );
        if (selected.path && selected.path !== operation.targetPath)
          throw new Error("Target checkout changed; create and review a new integration");
        if (operation.status === "publishing") {
          // 临时目录可能被手动切到候选提交；只有真实目标分支包含候选，才能对账为已合并。
          const included = await git.run({
            cwd: operation.targetPath,
            args: ["merge-base", "--is-ancestor", operation.candidateHead, selected.head],
          });
          if (
            included.exitCode === 0 &&
            target.branch === operation.targetBranch &&
            target.head === selected.head
          )
            return finish();
        }
        if (selected.head !== operation.targetHead || target.head !== operation.targetHead) {
          await options.save({
            ...operation,
            status: "failed",
            error: "Target HEAD changed; create and review a new integration",
          });
          throw new Error("Target HEAD changed; create and review a new integration");
        }
        await assertTargetCanAdvance(operation.targetPath, target.head, operation.candidateHead);
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
        // publishing 已持久化验证结果；响应丢失后的重试不能再次执行有副作用的验证命令。
        if (operation.status !== "ready" && operation.status !== "publishing")
          operation = await validateIntegrationCandidate(context, operation, options.validate);
        if (operation.status !== "ready" && operation.status !== "publishing") return operation;
        // 验证命令可能耗时；发布前重读真实 ref 与文件，旧 UI 状态不能代替 Git 前置。
        const checked = await git.inspect(operation.targetPath);
        const selectedAfter = await git.resolveTarget(
          operation.repositoryPath ?? operation.targetPath,
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
        if (
          (await git.command(operation.targetPath, ["rev-parse", "HEAD"])) !==
          operation.candidateHead
        )
          throw new Error("Target publication needs reconciliation");
        return finish();
      } finally {
        if (candidateLease) await options.coordinator.release(candidateLease);
        await options.coordinator.release(lease);
      }
    });
  };
}
