import type { MessageWithParts } from "@lcode/contracts";
import { getModelUsageContextTokens } from "@lcode/contracts";
import {
  mergeContextTrend,
  type ContextTrend,
  type ContextTrendSample,
} from "@lcode/shared/lcode-protocol-v4";

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** message/part 是冷恢复权威；事件仓库与当前 registry 都不能补造历史窗口。 */
export function contextTrendFromPersistedMessages(
  messages: readonly MessageWithParts[],
): ContextTrend {
  const samples: ContextTrendSample[] = [];
  for (const message of messages) {
    const info = message.info;
    if (info.metadata?.forkOrigin) continue;
    if (
      info.role === "assistant" &&
      !info.summary &&
      (info.time.completed !== undefined || info.finish)
    ) {
      const usedTokens = getModelUsageContextTokens({
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        totalTokens: info.tokens.total,
        cacheReadTokens: info.tokens.cache.read,
        cacheWriteTokens: info.tokens.cache.write,
      });
      if (usedTokens !== undefined) {
        const capacity = nonNegative(info.metadata?.contextWindowTokens);
        samples.push({
          id: `request:${info.id}`,
          timestamp: info.time.completed ?? info.time.created,
          kind: "request",
          usedTokens,
          maxTokens: capacity && capacity > 0 ? capacity : null,
          ...(info.providerId ? { providerId: String(info.providerId) } : {}),
          ...(info.modelId ? { modelId: String(info.modelId) } : {}),
          ...(info.anchor?.turnId ? { turnId: String(info.anchor.turnId) } : {}),
        });
      }
    }
    for (const part of message.parts) {
      const timeline =
        part.type === "timeline" &&
        part.timelineType === "context_compaction" &&
        part.status === "completed"
          ? part
          : undefined;
      const boundary = part.type === "compaction" ? part.compactBoundary : undefined;
      const usedTokens = nonNegative(
        timeline?.truePostCompactTokenCount ??
          timeline?.postCompactTokenCount ??
          boundary?.truePostCompactTokenCount ??
          boundary?.postCompactTokenCount,
      );
      if (usedTokens === undefined || (!timeline && !boundary)) continue;
      const operationId =
        timeline?.operationId ??
        (part.type === "compaction" ? part.operationId : undefined) ??
        boundary?.boundaryId;
      if (!operationId) continue;
      const before = nonNegative(timeline?.preCompactTokenCount ?? boundary?.preCompactTokenCount);
      samples.push({
        id: `compact:${operationId}`,
        timestamp: timeline?.time?.end ?? info.time.created,
        kind: "compact",
        usedTokens,
        maxTokens: null,
        ...(before !== undefined ? { tokensBefore: before } : {}),
        ...(info.anchor?.turnId ? { turnId: String(info.anchor.turnId) } : {}),
      });
    }
  }
  return mergeContextTrend(undefined, samples);
}
