import type { ModelRequestAuth } from "@lcode/contracts";
import { randomUUID } from "node:crypto";
import { apiKeyTokenBounds } from "./api-key-token-estimate.js";
import type { RoutingRequest } from "@lcode/provider";
import { ModelErrorCode, ModelFailureReason, ModelProtocolError } from "@lcode/contracts";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class RuntimeHeadersRefreshError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeHeadersRefreshError";
  }
}

export async function resolveModelForAttempt(input: {
  attempt: number;
  reason?: "model-request";
  request: AiSdkModelTextRequest;
  resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel;
  outsideTicket?: (wait: () => Promise<void>, signal?: AbortSignal) => Promise<void>;
}): Promise<ResolvedAiSdkModel> {
  const signal = input.request.abortSignal;
  signal?.throwIfAborted();
  const boundModel = input.resolveModel();
  const trace = input.request.traceContext;
  const tokens = apiKeyTokenBounds(
    boundModel.properties?.contextWindow,
    input.request.maxOutputTokens,
  );
  // 缓存兼容范围必须覆盖真实远端 attachment 与模型选项，空白 identity 沿路径 fallback。
  const modelScope = JSON.stringify([
    boundModel.providerKind,
    String(boundModel.modelId),
    boundModel.providerOptions?.apiFormat ?? null,
    "completion",
  ]);
  const context: RoutingRequest = {
    attemptId: randomUUID(),
    modelKey: modelScope,
    scopeKey: JSON.stringify([
      (typeof trace?.attributes?.workspaceIdentity === "string" &&
        trace.attributes.workspaceIdentity.trim()) ||
        trace?.attributes?.workspacePath ||
        null,
      trace?.attributes?.remoteSessionId ?? null,
      trace?.sessionId ?? trace?.traceId ?? randomUUID(),
      trace?.attributes?.executionId ?? null,
      trace?.attributes?.actorId ?? trace?.sessionId ?? null,
      boundModel.providerId,
      modelScope,
      input.request.selectedSpeed ?? null,
      input.request.providerOptions ?? boundModel.providerOptions ?? null,
    ]),
    turnId: trace?.turnId,
    tokens,
    workUnits: tokens.total ?? 4096,
    signal,
  };
  if (!input.request.refreshRuntimeHeadersBeforeAttempt)
    return acquireApiKeyAttempt(boundModel, signal, input.outsideTicket, context);
  try {
    const refreshResult = await waitForHeaders(
      () =>
        input.request.refreshRuntimeHeadersBeforeAttempt!({
          attempt: input.attempt,
          reason: input.reason ?? "model-request",
          abortSignal: signal,
          providerId: String(boundModel.providerId),
          modelId: String(boundModel.modelId),
          traceContext: input.request.traceContext,
        }),
      signal,
    );
    signal?.throwIfAborted();
    if (!refreshResult.headersApplied || !refreshResult.requestAuth) {
      throw createRequestAuthMissingError(
        "Provider request auth was not returned before model request attempt.",
        boundModel,
      );
    }
    // 当前绑定负责将完整鉴权材料投影到私有请求，不写共享 Registry，也不重新选择模型。
    return await acquireApiKeyAttempt(
      input.resolveModel(refreshResult.requestAuth),
      signal,
      input.outsideTicket,
      context,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ModelProtocolError && error.code === ModelErrorCode.ModelRequestCancelled)
      throw error;
    // 执行作用域凭据缺失已有稳定错误码；不能被 headers 等待的通用包装吞掉。
    if (isStructuredRequestAuthFailure(error)) {
      if (error instanceof ModelProtocolError) throw error;
      throw createRequestAuthMissingError(errorMessage(error), boundModel, error);
    }
    throw new RuntimeHeadersRefreshError(error);
  }
}

async function acquireApiKeyAttempt(
  model: ResolvedAiSdkModel,
  signal?: AbortSignal,
  outsideTicket?: (wait: () => Promise<void>, signal?: AbortSignal) => Promise<void>,
  context?: RoutingRequest,
): Promise<ResolvedAiSdkModel> {
  const attempt = await model.acquireApiKeyAttempt?.(signal, outsideTicket, context);
  return attempt ? { ...model, model: attempt.model, apiKeyAttempt: attempt } : model;
}

function createRequestAuthMissingError(
  message: string,
  model: ResolvedAiSdkModel,
  cause?: unknown,
): ModelProtocolError {
  const error = new ModelProtocolError(ModelErrorCode.ModelRequestAuthMissing, message, {
    modelId: String(model.modelId),
    providerId: String(model.providerId),
    reason: ModelFailureReason.AuthFailed,
    retryable: false,
  });
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isStructuredRequestAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const context =
    record.context && typeof record.context === "object"
      ? (record.context as Record<string, unknown>)
      : undefined;
  return (
    record.code === ModelErrorCode.ModelRequestAuthMissing ||
    context?.reason === ModelFailureReason.AuthFailed
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForHeaders<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
