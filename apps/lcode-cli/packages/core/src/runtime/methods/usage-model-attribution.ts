import {
  SessionEventType,
  getModelUsageContextTokens,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelUsage,
  type SessionEvent,
  type TraceContext,
} from "@lcode/contracts";

/** 只读取本次 invocation 的响应；并行子调用、上一轮和旧重试都不能决定当前账号。 */
export function invocationNetworkEvents(input: {
  events: readonly SessionEvent[];
  model: Model;
  traceContext: TraceContext;
}): ModelNetworkStatusEvent[] {
  return input.events.flatMap((event) => {
    if (event.type !== SessionEventType.ModelNetworkStatus) return [];
    const payload = event.payload as ModelNetworkStatusEvent;
    return payload.providerId === input.model.providerId &&
      payload.modelId === input.model.modelId &&
      payload.traceId === input.traceContext.traceId &&
      payload.spanId === input.traceContext.spanId &&
      (!input.traceContext.sessionId || payload.sessionId === input.traceContext.sessionId)
      ? [payload]
      : [];
  });
}

export function modelUsageAttribution(
  model: Model,
  events: readonly ModelNetworkStatusEvent[],
  usage: ModelUsage | undefined,
) {
  const providerId = String(model.providerId);
  const authChannelId = providerId.startsWith("oauth:")
    ? providerId.slice(6) || undefined
    : undefined;
  const final = events.findLast(
    (event) => event.type === "model_request_completed" || event.type === "model_request_failed",
  );
  // 最后尝试无响应时保持未知，不能回退到之前失败账号；API 响应也不能伪造 OAuth 归属。
  const connectionHeader = authChannelId
    ? Object.entries(final?.responseHeaders ?? {})
        .find(([name]) => name.toLowerCase() === "x-zcode-connection-id")?.[1]
        ?.trim() || undefined
    : undefined;
  // 统计协议只接收 Host 生成的 UUID；异常头不能污染整批严格 DTO。
  const accountConnectionId =
    connectionHeader &&
    /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu.test(connectionHeader)
      ? connectionHeader.toLowerCase()
      : undefined;
  const usageKnown = [
    usage?.inputTokens,
    usage?.outputTokens,
    usage?.totalTokens,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
    usage?.reasoningTokens,
  ].some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const capacity = model.properties.contextWindow;
  return {
    authChannelId,
    accountConnectionId,
    usageKnown,
    contextWindowTokens:
      capacity && Number.isFinite(capacity) && capacity > 0 ? capacity : undefined,
    contextUsedTokens: usageKnown ? getModelUsageContextTokens(usage) : undefined,
  };
}
