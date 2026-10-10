import type { IWorktreeService, WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_RETRY_WAIT_MS = 120_000;
const TRANSIENT_FILE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

/** 重试属于同一次已确认删除；不增加 UI 队列，不把等待当作停止/删除证明。 */
export async function retryConfirmedWorktreeDiscard(
  context: WorktreeContext,
  params: Parameters<IWorktreeService["archive"]>[0],
  attempt: () => Promise<WorktreeBinding>,
): Promise<WorktreeBinding> {
  let waitedMs = 0;
  let delayMs = INITIAL_RETRY_DELAY_MS;
  let retry = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (
        !context.discardRetryWait ||
        typeof errorCode !== "string" ||
        !TRANSIENT_FILE_ERROR_CODES.has(errorCode) ||
        waitedMs >= MAX_RETRY_WAIT_MS
      )
        throw error;
      const binding = await context.store.readBinding(params.bindingId);
      // 只能继续已有确认和 journal，不能因任意 EBUSY 自动接受新的删除范围。
      if (
        !binding?.deletion ||
        binding.status !== "deleting" ||
        binding.branch !== params.discard?.branch ||
        binding.checkoutPath !== params.discard.checkoutPath
      )
        throw error;
      const waitMs = Math.min(delayMs, MAX_RETRY_WAIT_MS - waitedMs);
      await context.discardRetryWait({
        bindingId: binding.id,
        requestId: binding.deletion.requestId,
        attempt: ++retry,
        delayMs: waitMs,
        errorCode,
      });
      waitedMs += waitMs;
      delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS);
      // 上一尝试已经释放锁/lease；重入原编排会重新验证 HEAD、scope、owner 和 writer。
    }
  }
}
