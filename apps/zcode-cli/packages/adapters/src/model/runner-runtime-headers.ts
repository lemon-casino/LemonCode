import type { ModelRequestAuth } from "@zcode/contracts";
import { ModelErrorCode, ModelFailureReason, ModelProtocolError } from "@zcode/contracts";
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
}): Promise<ResolvedAiSdkModel> {
  const signal = input.request.abortSignal;
  signal?.throwIfAborted();
  const boundModel = input.resolveModel();
  if (!input.request.refreshRuntimeHeadersBeforeAttempt) return boundModel;
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
    return input.resolveModel(refreshResult.requestAuth);
  } catch (error) {
    if (signal?.aborted) throw error;
    // 执行作用域凭据缺失已有稳定错误码；不能被 headers 等待的通用包装吞掉。
    if (isStructuredRequestAuthFailure(error)) {
      if (error instanceof ModelProtocolError) throw error;
      throw createRequestAuthMissingError(errorMessage(error), boundModel, error);
    }
    throw new RuntimeHeadersRefreshError(error);
  }
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
