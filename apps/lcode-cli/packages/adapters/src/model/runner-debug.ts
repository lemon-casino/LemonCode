import type { ModelTextResult } from "@lcode/contracts";
import { LCODE_RUNTIME_ENV_KEY, normalizeLCodeRuntimeEnv } from "@lcode/shared";
import { redactAnthropicRequestMetadata } from "./anthropic-request-metadata.js";
import type { EnvRecord } from "./model-execution.js";
import { getGenerateTextResultMetadata } from "./runner-diagnostics.js";
import { normalizeSources, normalizeToolResults, normalizeUsage } from "./runner-normalization.js";
import { stringMetadata } from "./runner-record.js";
import type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

import { writeModelIODebugRecord } from "./runner-debug-writer.js";
import {
  buildFallbackRequestBodyFromOptions,
  modelIOReasoningText,
  resolveFailedStreamModelIOAggregate,
  resolveStreamModelIOAggregate,
  serializeError,
} from "./runner-debug-aggregate.js";

export function shouldRecordModelIO(env: EnvRecord): boolean {
  // 开发态与生产态都记录(分别落到 debug / rollout 目录);仅测试态(LCODE_RUNTIME_ENV=test)不写,
  // 避免单测产生磁盘副作用。未设时按生产处理(记录到 rollout,带条数上限)。
  return normalizeRuntimeEnv(env) !== "test";
}

// 判定当前是否开发态,用于选择落盘目录(debug vs rollout)。
// 直接看 LCODE_RUNTIME_ENV === "development";dev 桌面/CLI 启动时已注入该变量。
export function isDevelopmentModelIOEnv(env: EnvRecord): boolean {
  return normalizeRuntimeEnv(env) === "development";
}

export function recordGenerateTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkGenerateTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkGenerateTextResult;
  startedAt: number;
}): void {
  if (!input.recordModelIO) {
    return;
  }

  const completedAt = Date.now();
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  const metadata = input.request.metadata ?? {};
  const requestBody =
    input.resolved.rawRequestBodyCapture?.body ??
    resultWithMetadata?.request?.body ??
    (input.error
      ? buildFallbackRequestBodyFromOptions({
          options: input.options,
          resolved: input.resolved,
          stream: false,
        })
      : undefined);

  writeModelIODebugRecord(
    {
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - input.startedAt,
      error: input.error ? serializeError(input.error) : undefined,
      requestId: input.requestId,
      attempt: input.attempt,
      model: {
        modelId: input.resolved.modelId,
        providerId: input.resolved.providerId,
      },
      request: {
        body: redactAnthropicRequestMetadata(requestBody),
        headers: input.options.headers,
        maxOutputTokens: input.options.maxOutputTokens,
        messages: input.request.messages,
        providerOptions: input.request.providerOptions,
        sdkMessages: input.options.messages,
        temperature: input.request.temperature,
        toolChoice: input.request.toolChoice,
        toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
      },
      response: input.result
        ? {
            body: resultWithMetadata?.response?.body,
            finishReason: input.result.finishReason,
            headers: resultWithMetadata?.response?.headers,
            modelId: resultWithMetadata?.response?.modelId,
            providerMetadata: input.result.providerMetadata,
            // 运行结果已有 reasoning，但 model-io 过去只记录 text，
            // 导致调用轨迹无法得到 response.reasoningText，始终不显示思考过程。
            reasoningText: modelIOReasoningText(input.result.reasoning),
            responseId: resultWithMetadata?.response?.id,
            text: input.result.text,
            toolCalls: input.normalizedToolCalls,
            toolResults: normalizeToolResults(input.result, input.normalizedToolCalls),
            sources: normalizeSources(input.result),
            usage: normalizeUsage(input.result.totalUsage ?? input.result.usage),
          }
        : undefined,
      sessionId: stringMetadata(metadata.sessionId),
      querySource: stringMetadata(metadata.querySource),
      startedAt: new Date(input.startedAt).toISOString(),
      traceId: stringMetadata(metadata.traceId),
      turnId: stringMetadata(metadata.turnId),
      type: "model_io",
    },
    input.debugDir,
    input.isDev,
    input.modelIoFullRetentionEnabled,
  );
}

/**
 * 流式请求的 model I/O 记录。
 *
 * 背景（bug：开发态桌面 agent 始终走流式，model-io 一直为空）：
 * 只在非流式 `runGenerateText` 里写 model-io 会让桌面/协议端默认 `modelStreaming: "on"` 的
 * 每个 turn（`streamText`）即便 LCODE_RUNTIME_ENV=development 也从不落盘。流式路径同样要记录。
 *
 * 与 generate 路径的关键差异：StreamTextResult 的 text/toolResults/sources/response 等聚合字段是 **promise**，
 * 必须等 fullStream 读完后再 await；toolResults/sources 的归一化期望数组，
 * 所以先解析聚合 promise，再用合成对象处理。toolCalls 则直接复用 assembler 的归一化快照。
 * 任何失败都不得影响模型请求路径。
 */
export async function recordStreamTextDebug(input: {
  attempt: number;
  debugDir?: string;
  error?: unknown;
  isDev: boolean;
  modelIoFullRetentionEnabled: boolean;
  normalizedToolCalls: ModelTextResult["toolCalls"];
  options: AiSdkStreamTextOptions;
  recordModelIO: boolean;
  request: AiSdkModelTextRequest;
  requestId: string;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkStreamTextResult;
  startedAt: number;
}): Promise<void> {
  if (!input.recordModelIO) {
    return;
  }

  try {
    // 成功路径下解析完整聚合结果；失败路径只读取 request/response 元数据，且必须限时——
    // 流中途被 abort（用户 Stop / idle timeout）后 AI SDK 的聚合 promise 永不 settle。
    const aggregate = input.result
      ? input.error
        ? await resolveFailedStreamModelIOAggregate(input.result, input.request.abortSignal)
        : await resolveStreamModelIOAggregate(input.result)
      : undefined;
    const completedAt = Date.now();
    const metadata = input.request.metadata ?? {};
    const requestBody =
      input.resolved.rawRequestBodyCapture?.body ??
      aggregate?.requestBody ??
      (input.error
        ? buildFallbackRequestBodyFromOptions({
            options: input.options,
            resolved: input.resolved,
            stream: true,
          })
        : undefined);
    const syntheticResult = {
      toolResults: aggregate?.toolResults,
      sources: aggregate?.sources,
    } as unknown as AiSdkGenerateTextResult;

    writeModelIODebugRecord(
      {
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - input.startedAt,
        error: input.error ? serializeError(input.error) : undefined,
        requestId: input.requestId,
        attempt: input.attempt,
        model: {
          modelId: input.resolved.modelId,
          providerId: input.resolved.providerId,
        },
        request: {
          body: redactAnthropicRequestMetadata(requestBody),
          headers: input.options.headers,
          maxOutputTokens: input.options.maxOutputTokens,
          messages: input.request.messages,
          providerOptions: input.request.providerOptions,
          sdkMessages: input.options.messages,
          temperature: input.request.temperature,
          toolChoice: input.request.toolChoice,
          toolNames: input.request.tools?.map((toolContract) => toolContract.name) ?? [],
        },
        response: aggregate
          ? {
              body: aggregate.responseBody,
              finishReason: aggregate.finishReason,
              headers: aggregate.responseHeaders,
              modelId: aggregate.responseModelId,
              providerMetadata: aggregate.providerMetadata,
              reasoningText: modelIOReasoningText(aggregate.reasoning),
              responseId: aggregate.responseId,
              text: aggregate.text,
              // assembler 是流式参数归一化的唯一所有者；
              // model-io 复用其快照，避免二次解析、重复 warn 和诊断结果漂移。
              toolCalls: input.normalizedToolCalls,
              toolResults: normalizeToolResults(syntheticResult, input.normalizedToolCalls),
              sources: normalizeSources(syntheticResult),
              usage: normalizeUsage(aggregate.usage),
            }
          : undefined,
        sessionId: stringMetadata(metadata.sessionId),
        querySource: stringMetadata(metadata.querySource),
        startedAt: new Date(input.startedAt).toISOString(),
        traceId: stringMetadata(metadata.traceId),
        turnId: stringMetadata(metadata.turnId),
        type: "model_io",
      },
      input.debugDir,
      input.isDev,
      input.modelIoFullRetentionEnabled,
    );
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

// 归一化 LCODE_RUNTIME_ENV；未设置时返回 undefined,由调用方按生产处理。
function normalizeRuntimeEnv(env: EnvRecord): string | undefined {
  return normalizeLCodeRuntimeEnv(env[LCODE_RUNTIME_ENV_KEY]);
}
