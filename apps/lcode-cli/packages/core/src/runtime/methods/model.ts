import { beginLocalTurnPreparation } from "@lcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import {
  logModelRequestMediaSummary,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  normalizeModelToolCallsForRuntime,
  projectMessagesWithMediaAttachmentPaths,
  projectMessagesForInputFormat,
  projectMessagesForMediaBudget,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import { consumeModelTextStream } from "./model-stream.js";

export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  // 闲时 turn 只覆盖了父 runtime 的默认模型，foreground child 重新建
  // request 时仍读取 session 配置，导致 provider options/capability 与本轮模型分叉。
  // turn 快照存在时必须整体采用快照，不能用 `??` 回退到用户模型的字段。
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
    // 重试预算与准入端口不在这里设：它们是 runtime 层字段，由 createRuntimeModel 绑在句柄上，turn step 与工具内部的模型调用同一来源。
    modelCall: {
      // 普通 Agent Step 以前只靠 metadata.querySource 在 Adapter 中反推
      // operation/actor；元数据一旦改名或缺失，就会误记为 tool_internal_model_call。
      // Runtime 已经拥有原始执行语义，应在请求边界直接声明，旧映射只作兼容兜底。
      actorKind: this.agentTelemetry.actorKind,
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    statusSink: this.createModelStatusSink(projectedOptions.traceContext, projectedOptions.events, {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    }),
    traceContext: projectedOptions.traceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: projectedOptions.abortSignal,
      model,
      traceContext: projectedOptions.traceContext,
    }),
    shouldYieldRetryToFailover: projectedOptions.shouldYieldRetryToFailover,
    retryAttemptOffset: projectedOptions.retryAttemptOffset,
    // SSE 已经输出后由 core recovery 重发新请求；这些请求在 adapter 看起来都是 attempt=1，
    // 必须把 recovery 次数带过去，才能把 idle timeout 从首请求窗口逐次递增。
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);

  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      model.generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  return await consumeModelTextStream.call(this, options, {
    contextUsageBreakdown,
    executionModelSelection,
    finishAssembly,
    model,
    modelInvocationContext,
    modelRequest,
  });
}
