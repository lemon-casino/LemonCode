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
  const scope = values.get("x-lcode-rate-limit-scope");
  return {
    outcome: cancelled ? "cancelled" : "failed",
    replaySafeFailure:
      !cancelled && !outputCommitted && [400, 401, 403, 429].includes(statusCode ?? 0),
    ...(statusCode !== undefined && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
    ...(statusCode === 429
      ? { retryAfterMs: Math.min(86400000, readRateLimitHint(values).delayMs) }
      : {}),
    ...(scope === "key" || scope === "shared" ? { rateLimitScope: scope } : {}),
  };
}

export function createRoutingFeedback(
  fetch: typeof globalThis.fetch,
  baseURL: string,
  apiKey: string | undefined,
  logger?: Logger,
) {
  return async (usage: RoutingUsage) => {
    try {
      const response = await fetch(`${baseURL}/routing/usage`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(usage),
        signal: AbortSignal.timeout(FEEDBACK_TIMEOUT),
      });
      await response.body?.cancel();
      if (!response.ok)
        logger?.warn("Routing feedback was rejected; conservative reservation retained");
    } catch {
      logger?.warn("Routing feedback unavailable; conservative reservation retained");
    }
  };
}
