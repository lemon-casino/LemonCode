import type { WorktreeIntegration } from "../contract.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";
import type { WorktreeContext } from "./ports.js";
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
    if (original.status === "published" && original.candidateHead === params.approvedCandidateHead)
      return original;
    return store.lock(original.id, async () => {
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
        if (target.branch !== operation.targetBranch)
          throw new Error("Target branch changed after integration review");
        if (operation.status === "published") return operation;
        await git.assertIdle(operation.targetPath);
        if (operation.status === "publishing") {
          const included = await git.run({
            cwd: operation.targetPath,
            args: ["merge-base", "--is-ancestor", operation.candidateHead, target.head],
          });
          if (included.exitCode === 0)
            return options.save({ ...operation, status: "published", error: undefined });
        }
        if (target.head !== operation.targetHead) {
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
        if (checked.head !== operation.targetHead || checked.branch !== operation.targetBranch)
          throw new Error("Target changed during validation");
        await assertTargetCanAdvance(
          operation.targetPath,
          checked.head,
          params.approvedCandidateHead,
        );
        operation = await options.save({ ...operation, status: "publishing" });
        await context.fault("publish.before-merge");
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
        return options.save({ ...operation, status: "published", error: undefined });
      } finally {
        if (candidateLease) await options.coordinator.release(candidateLease);
        await options.coordinator.release(lease);
      }
    });
  };
}
