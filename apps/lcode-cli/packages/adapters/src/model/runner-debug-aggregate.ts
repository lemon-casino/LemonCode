import { normalizeReasoning, normalizeUsage } from "./runner-normalization.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

export function buildFallbackRequestBodyFromOptions(input: {
  options: AiSdkGenerateTextOptions | AiSdkStreamTextOptions;
  resolved: ResolvedAiSdkModel;
  stream: boolean;
}): Record<string, unknown> {
  const options = input.options as Record<string, unknown>;
  return removeUndefined({
    // 失败路径经常拿不到 AI SDK 暴露的 raw request.body。此处记录送入
    // AI SDK 的完整 payload 快照，方便排查 provider 400 的 messages/tools 结构。
    bodySource: "ai_sdk_options",
    experimental_include: options.experimental_include,
    frequencyPenalty: options.frequencyPenalty,
    maxOutputTokens: options.maxOutputTokens,
    messages: options.messages,
    model: input.resolved.modelId,
    presencePenalty: options.presencePenalty,
    providerOptions: options.providerOptions,
    seed: options.seed,
    stopSequences: options.stopSequences,
    stream: input.stream,
    temperature: options.temperature,
    toolChoice: options.toolChoice,
    tools: options.tools,
    topK: options.topK,
    topP: options.topP,
  });
}

interface StreamModelIOAggregate {
  finishReason?: unknown;
  providerMetadata?: unknown;
  reasoning?: unknown;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: unknown;
  responseId?: unknown;
  responseModelId?: unknown;
  sources?: unknown;
  text?: unknown;
  toolResults?: unknown;
  usage?: Parameters<typeof normalizeUsage>[0];
}

// StreamTextResult 的聚合字段都是 promise，逐个 best-effort 解析(失败回退 undefined)。
export async function resolveStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
): Promise<StreamModelIOAggregate> {
  const streamResult = result as unknown as {
    text?: Promise<unknown>;
    reasoning?: Promise<unknown>;
    finishReason?: Promise<unknown>;
    totalUsage?: Promise<unknown>;
    usage?: Promise<unknown>;
    toolResults?: Promise<unknown>;
    sources?: Promise<unknown>;
    providerMetadata?: Promise<unknown>;
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };

  const [
    text,
    reasoning,
    finishReason,
    totalUsage,
    usage,
    toolResults,
    sources,
    providerMetadata,
    request,
    response,
  ] = await Promise.all([
    settleModelIOValue(streamResult.text),
    settleModelIOValue(streamResult.reasoning),
    settleModelIOValue(streamResult.finishReason),
    settleModelIOValue(streamResult.totalUsage),
    settleModelIOValue(streamResult.usage),
    settleModelIOValue(streamResult.toolResults),
    settleModelIOValue(streamResult.sources),
    settleModelIOValue(streamResult.providerMetadata),
    settleModelIOValue(streamResult.request),
    settleModelIOValue(streamResult.response),
  ]);

  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    text,
    reasoning,
    finishReason,
    usage: (totalUsage ?? usage) as StreamModelIOAggregate["usage"],
    toolResults,
    sources,
    providerMetadata,
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

export function modelIOReasoningText(reasoning: unknown): string | undefined {
  if (!Array.isArray(reasoning)) {
    return undefined;
  }

  const text = normalizeReasoning(reasoning)
    ?.map((part) => part.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return text && text.length > 0 ? text : undefined;
}

// 流中途被 abort 后，AI SDK 的 request/response 聚合 promise 既不 resolve 也不 reject
// （只有流正常读完或流级报错才会 settle），无限 await 会把 runner-stream 的 catch 挂死，
// turn 永不结束、activeAbortController 永不释放，session 从此拒绝一切新 prompt。
// 诊断记录是 best-effort：调用方已 abort 时直接跳过聚合，其余失败限时等待。
const FAILED_STREAM_AGGREGATE_TIMEOUT_MS = 1_000;

export async function resolveFailedStreamModelIOAggregate(
  result: AiSdkStreamTextResult,
  abortSignal?: AbortSignal,
): Promise<StreamModelIOAggregate> {
  if (abortSignal?.aborted) {
    // 用户 Stop：让失败路径立即走完，request body 由 fallback 快照兜底。
    return {};
  }
  const streamResult = result as unknown as {
    request?: Promise<unknown>;
    response?: Promise<unknown>;
  };
  const [request, response] = await Promise.all([
    settleModelIOValueWithTimeout(streamResult.request, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
    settleModelIOValueWithTimeout(streamResult.response, FAILED_STREAM_AGGREGATE_TIMEOUT_MS),
  ]);
  const requestRecord = (request ?? undefined) as { body?: unknown } | undefined;
  const responseRecord = (response ?? undefined) as
    | { id?: unknown; modelId?: unknown; headers?: unknown; body?: unknown }
    | undefined;

  return {
    requestBody: requestRecord?.body,
    responseBody: responseRecord?.body,
    responseHeaders: responseRecord?.headers,
    responseId: responseRecord?.id,
    responseModelId: responseRecord?.modelId,
  };
}

async function settleModelIOValue<T>(value: Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return await value;
  } catch {
    return undefined;
  }
}

// 用户 stop / v4 sendQueuedNow 抢占会 abort 当前流式请求；此时
// AI SDK StreamTextResult 的 request/response 聚合 promise 永不 settle——流被中途放弃，
// 聚合要等 fullStream 关闭才 resolve，而关闭 iterator 的 finally（runner-stream.ts）
// 又排在本 await 之后，形成循环等待。settleModelIOValue 只兜 reject 不兜「不 settle」，
// 导致 runStreamText 的 catch 永远不结束：TurnCancelled 无法上抛、turn 永不收口、
// record.activeAbortController 不释放、UI 的 stop（canStop）永久失效
// （e2e 复现：conversation-session-v4-vertical-slice / v4-sendnow）。
// 失败路径的 model-io 记录必须有界等待：超时按「值不可得」处理，绝不阻塞错误传播。
async function settleModelIOValueWithTimeout<T>(
  value: Promise<T> | T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
    return await Promise.race([settleModelIOValue(value), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}
