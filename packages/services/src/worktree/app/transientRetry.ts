import type { WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_RETRY_WAIT_MS = 120_000;
const TRANSIENT_FILE_ERROR_CODES = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);

/**
 * 重试属于同一次已确认的归档/删除；不增加 UI 队列，不把等待当作停止或删除证明。
 * 只有持久 journal 仍是原确认时才继续，绝不因任意瞬时文件锁接受新的操作范围。
 */
export async function retryConfirmedWorktreeOperation<T>(
  context: WorktreeContext,
  params: {
    bindingId: string;
    /** 原 journal 的 requestId；返回 undefined 表示原确认已失效，必须原样失败。 */
    resume: (binding: WorktreeBinding) => string | undefined;
  },
  attempt: () => Promise<T>,
): Promise<T> {
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
        !context.transientRetryWait ||
        typeof errorCode !== "string" ||
        !TRANSIENT_FILE_ERROR_CODES.has(errorCode) ||
        waitedMs >= MAX_RETRY_WAIT_MS
      )
        throw error;
      const binding = await context.store.readBinding(params.bindingId);
      const requestId = binding ? params.resume(binding) : undefined;
      if (!binding || !requestId) throw error;
      const waitMs = Math.min(delayMs, MAX_RETRY_WAIT_MS - waitedMs);
      await context.transientRetryWait({
        bindingId: binding.id,
        requestId,
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
