import type { TokenUsageInfo } from "@lcode/contracts";

export interface PersistedTokenUsageBaseline {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextUsageTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

export function persistedTokenUsageBaseline(
  tokens: TokenUsageInfo | undefined,
): PersistedTokenUsageBaseline | undefined {
  if (!tokens) return undefined;
  const inputTokens = persistedInputWindowTokens(tokens);
  if (inputTokens === undefined || inputTokens <= 0) return undefined;

  const outputTokens = positiveInteger(tokens.output) ?? 0;
  const cacheReadTokens = nonNegativeInteger(tokens.cache.read) ?? 0;
  const cacheWriteTokens = nonNegativeInteger(tokens.cache.write) ?? 0;
  const totalTokens = positiveInteger(tokens.total);
  // 历史 TokenUsageInfo 会把缺失的 provider outputTokens 归一化成 0。
  // 没有可用 total 时，0 无法证明 usage 已覆盖 assistant，必须把 assistant 留给本地估算。
  const contextUsageTokens =
    outputTokens > 0
      ? inputTokens + outputTokens
      : totalTokens !== undefined && totalTokens >= inputTokens
        ? totalTokens
        : undefined;

  return {
    cacheReadTokens,
    cacheWriteTokens,
    contextUsageTokens,
    inputTokens,
    outputTokens,
  };
}

function persistedInputWindowTokens(tokens: TokenUsageInfo): number | undefined {
  const inputTokens = positiveInteger(tokens.input);
  if (inputTokens !== undefined) return inputTokens;

  const totalTokens = positiveInteger(tokens.total);
  if (totalTokens !== undefined) {
    return Math.max(0, totalTokens - (nonNegativeInteger(tokens.output) ?? 0));
  }

  const cacheTokens =
    (nonNegativeInteger(tokens.cache.read) ?? 0) + (nonNegativeInteger(tokens.cache.write) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}
