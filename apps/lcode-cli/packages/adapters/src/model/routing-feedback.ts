import type { Logger } from "@lcode/contracts";
import { readRateLimitHint } from "@lcode/provider";
import type { RoutingUsage } from "@lcode/shared";

const FEEDBACK_TIMEOUT = 5000;
export function routingFailure(
  statusCode: number | undefined,
  headers: Record<string, string> | undefined,
  outputCommitted = false,
  cancelled = false,
): RoutingUsage {
  const values = new Headers(headers);
  const scope = values.get("x-lcode-rate-limit-scope")?.trim().toLowerCase();
  return {
    outcome: cancelled ? "cancelled" : "failed",
    replaySafeFailure:
      !cancelled && !outputCommitted && [400, 401, 403, 429].includes(statusCode ?? 0),
    ...(statusCode !== undefined && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
    ...(statusCode === 429 || (statusCode !== undefined && statusCode >= 500)
      ? { retryAfterMs: Math.min(86400000, readRateLimitHint(values).delayMs) }
      : {}),
    ...(scope === "key" ||
    scope === "shared" ||
    scope === "pool" ||
    scope === "model" ||
    scope === "provider"
      ? { rateLimitScope: scope }
      : {}),
  };
}

export function createRoutingFeedback(
  fetch: typeof globalThis.fetch,
  baseURL: string,
  apiKey: string | undefined,
  logger?: Logger,
) {
  let state = { pending: false, attempts: 0, delivered: false };
  const send = async (usage: RoutingUsage) => {
    const body = JSON.stringify(usage);
    state = { pending: true, attempts: 0, delivered: false };
    for (let attempt = 0; attempt < 3; attempt++) {
      state.attempts++;
      try {
        const response = await fetch(`${baseURL}/routing/usage`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(FEEDBACK_TIMEOUT),
        });
        await response.body?.cancel();
        if (response.ok) {
          state.pending = false;
          state.delivered = true;
          return;
        }
        if (response.status < 500 && response.status !== 429) break;
      } catch {
        /* 网络未知只重试不可变反馈，不重放模型 POST。 */
      }
    }
    state.pending = false;
    logger?.warn(
      "Routing feedback unconfirmed after bounded retries; conservative reservation retained",
    );
  };
  return Object.assign(send, { diagnostics: () => ({ ...state }) });
}
