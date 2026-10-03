import { resolve } from "node:path";
import { gitCommitRequestSchema } from "@lcode/shared";
import type { WorktreeBinding, WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";

export async function commitIntegrationSource(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  binding: WorktreeBinding,
  operation: WorktreeIntegration,
): Promise<WorktreeIntegration> {
  if (!operation.sourceCommits?.length) return operation;
  if (!context.commitSource)
    throw new Error("Reviewed source commits are unavailable on this Host");
  const save = async (next: WorktreeIntegration) => {
    operation = { ...next, updatedAt: new Date().toISOString() };
    await context.store.saveOperation(operation);
    return operation;
  };
  const lease = await coordinator.acquire({
    workspacePath: binding.checkoutPath,
    ownerId: operation.id,
  });
  try {
    if (operation.sourceReceipts?.some((receipt) => receipt.warning))
      throw new Error(operation.error ?? "Source commit recovery requires manual review");
    for (const raw of operation.sourceCommits.slice(operation.sourceReceipts?.length ?? 0)) {
      const request = gitCommitRequestSchema.parse(raw);
      const normalize = (path: string) =>
        process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
      if (
        !request.review ||
        normalize(request.workspacePath) !== normalize(binding.workspacePath) ||
        (request.workspaceIdentity?.trim() || "") !== (binding.workspaceIdentity?.trim() || "")
      )
        throw new Error("Source review does not belong to the worktree execution scope");
      const previous = operation.sourceReceipts?.at(-1);
      const result = await context.commitSource({
        ...request,
        ...(previous ? { expectedState: previous.publishState } : {}),
      });
      await context.fault("integrate.after-source-commit");
      const receipt = {
        reviewId: request.review.id,
        groupId: request.review.groupId,
        commitHash: result.commitHash,
        ...(result.warning ? { warning: result.warning } : {}),
        ...(result.publishState ? { publishState: result.publishState } : {}),
      };
      await save({
        ...operation,
        sourceHead: result.commitHash,
        sourceReceipts: [...(operation.sourceReceipts ?? []), receipt],
      });
      if (result.warning) throw new Error(result.warning);
    }
    return save({ ...operation, status: "preparing", error: undefined });
  } catch (error) {
    // 中文依据：已提交组保留逐组收据；重启后只重放剩余请求，由 Git owner 持久收据判断是否已经提交。
    return save({
      ...operation,
      status: "source-commit-failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await coordinator.release({ token: lease.token, ownerId: operation.id });
  }
}
