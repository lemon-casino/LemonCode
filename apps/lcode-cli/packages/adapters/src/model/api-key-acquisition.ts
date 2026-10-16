import { RoutingError, waitForRateLimitDelay } from "@lcode/provider";
import type { ApiKeyLease } from "./api-key-lease.js";
export type OutsideApiKeyTicket = (
  wait: () => Promise<void>,
  signal?: AbortSignal,
) => Promise<void>;
interface AcquisitionHost {
  signal: AbortSignal;
  waitMs(): number;
  indexReady(): boolean;
  prepareIndex(signal: AbortSignal): Promise<void>;
  prepareInline(signal: AbortSignal): boolean;
  reserve(): ApiKeyLease;
  prepareShared?(lease: ApiKeyLease, signal: AbortSignal): Promise<ApiKeyLease>;
}
/** 仅编排原池的 admission，等待不占 Key/Token 预留，也不增加 Runner 尝试。 */
export async function acquireApiKeyLease(
  host: AcquisitionHost,
  outside: OutsideApiKeyTicket,
): Promise<ApiKeyLease> {
  const signal = host.signal;
  for (;;) {
    signal.throwIfAborted();
    if (host.waitMs() > 0)
      await outside(async () => {
        for (;;) {
          signal.throwIfAborted();
          const delay = host.waitMs();
          if (delay === 0) return;
          await waitForRateLimitDelay(delay, signal);
        }
      }, signal);
    // 小目录在一个有界片段内即可完成，不为纯同步计算额外释放/重获物理 admission。
    if (!host.indexReady() && !host.prepareInline(signal)) {
      try {
        await outside(() => host.prepareIndex(signal), signal);
      } catch (error) {
        if (error instanceof RoutingError && error.code === "policy-conflict" && !signal.aborted)
          continue;
        throw error;
      }
    }
    signal.throwIfAborted();
    // admission 重获期间 profile 可被 LRU 淘汰或并发 429 失效；预留前必须重读。
    if (host.waitMs() > 0 || !host.indexReady()) continue;
    const lease = host.reserve();
    if (!host.prepareShared || !lease.sharedQuotaInput) return lease;
    try {
      let prepared!: ApiKeyLease;
      await outside(async () => {
        prepared = await host.prepareShared!(lease, signal);
      }, signal);
      return prepared;
    } catch (error) {
      lease.release();
      throw error;
    }
  }
}
