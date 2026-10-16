import type { ProviderApiKey } from "@lcode/provider";
import { ApiKeyPool, type ApiKeyFailoverState, type ApiKeyLease } from "./api-key-pool.js";
import { observeApiKeyResponse } from "./api-key-response.js";

export type { ApiKeyFailoverState } from "./api-key-pool.js";

export function withApiKeyLease(
  fetch: typeof globalThis.fetch,
  lease: ApiKeyLease,
  providerKind: string,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    // 私有副本可直接写 headers；额外临时 clone 的取消 controller 在 GC 后会断开上游信号。
    request.headers.set("Authorization", `Bearer ${lease.key.apiKey}`);
    if (providerKind === "anthropic") request.headers.set("x-api-key", lease.key.apiKey);
    if (lease.begin && !lease.begin()) throw new Error("attempt-already-dispatched");
    let response: Response;
    try {
      response = await fetch(request);
    } catch (error) {
      lease.end?.(false);
      throw error;
    }
    if (request.signal.aborted) {
      // 响应头和取消同拍时尚未安装 body observer；必须让取消完成句柄负责物理收尾。
      void (response.body?.cancel(request.signal.reason) ?? Promise.resolve())
        .finally(() => lease.end?.(false))
        .catch(() => {});
    }
    request.signal.throwIfAborted();
    lease.observe(response.status, response.headers);
    return lease.end ? observeApiKeyResponse(response, request.signal, lease.end) : response;
  };
}

/** 公开 helper 保留有限轮换语义；正常 Runner 使用单租约 fetch，不在此隐藏多次 POST。 */
export function createApiKeyFailoverFetch(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly keys: readonly ProviderApiKey[];
  readonly providerKind: string;
  readonly state?: ApiKeyFailoverState;
  readonly pool?: ApiKeyPool;
}): typeof globalThis.fetch {
  if (!options.keys.length) return options.fetch;
  const state = options.state;
  const pool =
    options.pool ??
    (state?.pool?.sourceKeys === options.keys ? state.pool : new ApiKeyPool(options.keys, state));
  if (state) state.pool = pool;
  return async (input, init) => {
    const template = new Request(input, init);
    for (;;) {
      template.signal.throwIfAborted();
      const lease = await pool.acquire(template.signal);
      try {
        const response = await withApiKeyLease(
          options.fetch,
          lease,
          options.providerKind,
        )(template.clone());
        if (pool.routingEnabled || !lease.canRotate) return response;
        await response.body?.cancel();
      } finally {
        lease.release();
      }
    }
  };
}
