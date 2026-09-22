import type { MessageWithParts } from "@zcode/contracts";
import type { SessionUsageState } from "@zcode/shared/zcode-protocol-v4";

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function cumulativeFromPersistedMessages(
  messages: readonly MessageWithParts[],
): SessionUsageState["cumulative"] | null {
  const cumulative = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let recorded = false;
  for (const message of messages) {
    const info = message.info;
    if (
      info.role !== "assistant" ||
      info.summary ||
      info.metadata?.forkOrigin ||
      (info.time.completed === undefined && !info.finish)
    ) {
      continue;
    }
    const output = nonNegative(info.tokens.output);
    const input =
      nonNegative(info.tokens.input) ||
      Math.max(0, nonNegative(info.tokens.total) - output) ||
      nonNegative(info.tokens.cache.read) + nonNegative(info.tokens.cache.write);
    if (input === 0 && output === 0) continue;

    // 持久化的 input 已包含缓存读写；只在明细中记录缓存，绝不再次加到总量。
    cumulative.inputTokens += input;
    cumulative.outputTokens += output;
    cumulative.cacheReadTokens += nonNegative(info.tokens.cache.read);
    cumulative.cacheWriteTokens += nonNegative(info.tokens.cache.write);
    recorded = true;
  }
  return recorded ? cumulative : null;
}
