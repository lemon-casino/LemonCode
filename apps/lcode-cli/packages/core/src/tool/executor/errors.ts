import { CoreErrorType, createCoreError, isCoreError } from "@lcode/contracts";
import { projectExecutionErrorPayload } from "../../errors/error-payload.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolHandlerFailure } from "../types.js";
import { getInitialInputValidationModelContent } from "./validation.js";

export function createErrorResult(
  toolCall: ExecutableToolCall,
  error: Error,
  durationMs?: number,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  const handlerFailure =
    isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure)
      ? error.context.toolHandlerFailure
      : undefined;
  // 根因：通用错误层按 tool name 拼接 provider 文案会反向依赖具体工具。
  // handler 只返回自己的 code/message；这里统一组装 envelope，并保留裸 message 给 UI 和日志。
  const inputValidationContent = getInitialInputValidationModelContent(error);
  const modelContent =
    inputValidationContent ??
    (handlerFailure ? `<tool_use_error>${handlerFailure.message}</tool_use_error>` : undefined);
  // subagent/turn/model 错误常把真实 provider 原因包在 cause 链里；
  // tool result 是父模型和 UI hover 的共同来源，必须在这里统一投影成可读摘要。
  const projectedError = projectExecutionErrorPayload(error);
  // 中文依据：首次 schema 错误已有具体字段问题，但旧 UI 只收到泛化的 inputSchema
  // 失败；复用原模型反馈和同一有界摘要器，不披露输入值、不改变校验/修复生命周期。
  const validationMessage = inputValidationContent
    ? projectExecutionErrorPayload({
        message: inputValidationContent
          .replace(/^<tool_use_error>/u, "")
          .replace(/<\/tool_use_error>$/u, ""),
      }).message
    : undefined;
  const reasonSource =
    isCoreError(error) &&
    (error.context?.reasonSource === "plan_approval_feedback" ||
      error.context?.reasonSource === "workflow_refine_feedback")
      ? error.context.reasonSource
      : undefined;
  // ExitPlanMode / workflow Refine 的用户反馈会暂存在 PermissionDenied.message，
  // 后续还要原样转成 steer 输入；这里不能被展示摘要器截断，否则超长反馈不会触发 input_too_large。
  // 普通拒绝附带的自由文本反馈（preserveReasonFormatting）同理原样保留。
  const message =
    reasonSource !== undefined || options?.preserveReasonFormatting === true
      ? error.message
      : (validationMessage ?? projectedError.message);
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    success: false,
    output: null,
    error: {
      type: isCoreError(error) ? error.type : error.name,
      message,
      ...(handlerFailure
        ? { code: String(handlerFailure.errorCode) }
        : projectedError.code
          ? { code: projectedError.code }
          : {}),
      ...(projectedError.detail ? { detail: projectedError.detail } : {}),
      ...(reasonSource ? { reasonSource } : {}),
      stack: error.stack,
    },
    ...(modelContent === undefined ? {} : { modelContent }),
    durationMs: durationMs ?? 0,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

export function createToolHandlerFailureError(
  toolCall: ExecutableToolCall,
  failure: ToolHandlerFailure,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, failure.message, {
    context: {
      code: failure.errorCode,
      toolHandlerFailure: failure,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    },
    recoverable: true,
  });
}

export function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ToolHandlerFailure>;
  return (
    candidate.result === false &&
    typeof candidate.errorCode === "number" &&
    Number.isFinite(candidate.errorCode) &&
    typeof candidate.message === "string"
  );
}

export function isToolHandlerFailureError(error: unknown): boolean {
  return isCoreError(error) && isToolHandlerFailure(error.context?.toolHandlerFailure);
}

export function createPermissionErrorResult(
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  context: Record<string, unknown>,
  options?: {
    preserveReasonFormatting?: boolean;
  },
): ToolExecutionResult {
  return createErrorResult(
    toolCall,
    createCoreError(
      CoreErrorType.PermissionDenied,
      reason ?? `Permission denied for ${toolCall.name}`,
      {
        context: {
          ...context,
          toolName: toolCall.name,
        },
        recoverable: true,
      },
    ),
    undefined,
    options,
  );
}
