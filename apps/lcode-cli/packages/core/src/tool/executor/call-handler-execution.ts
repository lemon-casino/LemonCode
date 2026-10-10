import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type Model,
  type SessionEvent,
  type SkillTelemetryMetadata,
  type ToolExecutionSpanWriter,
  type TraceContext,
  type TurnId,
} from "@lcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@lcode/lcode-cua/frame-contract";
import type { HookRunResult } from "../../hooks/types.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  createErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
  isToolHandlerFailureError,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
} from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { withAutomationCreateLimitTurnStop, withTerminalToolTurnStop } from "./turn-control.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateOutput } from "./validation.js";
import { errorCategoryForToolError, resolveModelOutputEntry } from "./call-result-policy.js";
import { createToolExecutionContext } from "./call-execution-context.js";

export interface ToolHandlerExecutionInput {
  deps: ToolExecutorDeps;
  backgroundTasks: BackgroundTaskTracker;
  canonicalToolCall: ExecutableToolCall;
  totalStartedAt: number;
  options: ToolExecuteOptions | undefined;
  telemetry: ToolExecutionSpanWriter | undefined;
  entry: ToolEntry;
  model: Model | undefined;
  traceContext: TraceContext;
  traceId: TraceContext["traceId"];
  turnId: TurnId | undefined;
  executionInput: unknown;
  preToolHookResult: HookRunResult;
  permissionWaitMs: number | undefined;
}

export async function executeAdmittedToolHandler(
  input: ToolHandlerExecutionInput,
): Promise<ToolExecutionResult> {
  const {
    deps,
    backgroundTasks,
    canonicalToolCall,
    totalStartedAt,
    options,
    telemetry,
    entry,
    model,
    traceContext,
    traceId,
    turnId,
    executionInput,
    preToolHookResult,
    permissionWaitMs,
  } = input;
  const startTime = Date.now();
  const executionAbortController = new AbortController();
  const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
  let releaseOperation: (() => void) | undefined;
  let handlerStarted = false;
  const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
    model,
  });
  // 可暂停的 deadline：本次调用内部的模型请求在准入闸门前排队时暂停计时。排队的两端
  // 以本 toolCallId 的 ModelNetworkStatus 会话事件到达，所以在事件出口拦一层即可，handler 无感。
  const deadline = new ToolDeadline(timeoutMs);
  const emitEvent =
    deps.emitEvent === undefined
      ? undefined
      : async (event: SessionEvent): Promise<void> => {
          observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
          await deps.emitEvent(event);
        };
  let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
  let failureStage: "handler" | "serialize" | "post_hook" = "handler";
  let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;

  try {
    // 准入早于 started 事件；handler 超时返回后仍可能在清理，锁必须由真实 handler 的 finally 释放。
    const capability = resolveToolCallCapabilityFlags(deps, entry, executionInput);
    releaseOperation = await deps.toolOperationAdmission?.acquire({
      toolName: canonicalToolCall.name,
      toolInput: executionInput,
      ...capability,
      workingDirectory: deps.getWorkingDirectory(),
      workspaceRoot: deps.getWorkspaceRoot(),
      signal: executionAbortController.signal,
    });
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      Date.now(),
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      capability,
    );
    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });
    const context = createToolExecutionContext({
      deps,
      canonicalToolCall,
      traceContext,
      traceId,
      turnId,
      abortSignal: executionAbortController.signal,
      emitEvent,
      telemetry,
      options,
      recordReadFileStateMetadata: (metadata) => {
        readFileStateMetadata = metadata;
      },
      recordSkillTelemetryMetadata: (metadata) => {
        skillTelemetryMetadata = metadata;
      },
    });

    const output = await executeWithTimeout(
      async (input, context) => {
        handlerStarted = true;
        try {
          return await entry.handler(input, context);
        } finally {
          releaseOperation?.();
          releaseOperation = undefined;
        }
      },
      executionInput,
      context,
      deadline,
      executionAbortController,
      entry,
    );
    const durationMs = Date.now() - startTime;
    if (isToolHandlerFailure(output)) {
      // handler 用返回值表达可预期业务失败；这里只转换到既有异常控制流，
      // 继续复用原来的 failure hook、事件和日志，不引入第二套执行生命周期。
      throw createToolHandlerFailureError(canonicalToolCall, output);
    }
    validateOutput(output, entry);
    // node_repl 同时承载 Browser Use 与 CUA，不能在注册时把整个 server 标成 official。
    // CUA SDK 结果带 producer integrity metadata 时，才为本次序列化临时打开原子帧保护；
    // 否则通用 resultBudget 会截断/重排 image_ref，或非 authority 路径会把引用剥掉。
    const modelOutputEntry = resolveModelOutputEntry(entry, output);
    failureStage = "serialize";
    let serialization = await serializeOutput(
      deps,
      output,
      modelOutputEntry,
      traceContext,
      canonicalToolCall.id,
      executionAbortController.signal,
    );
    failureStage = "post_hook";
    const postToolHookResult = await runPostToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      output,
      serialization.artifactPath,
      traceContext,
      options?.signal,
    );
    serialization = appendHookAdditionalContexts(
      serialization,
      [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
      modelOutputEntry,
    );
    const display = createToolResultDisplay(canonicalToolCall.name, output, {
      mcp: entry.metadata.mcpPresentation,
      officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    });
    const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
      permissionWaitMs,
      // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
      // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
      totalMs: Date.now() - totalStartedAt,
    });

    const finalModelContent = serialization.modelContent ?? serialization.content;
    const modelContentProtection = modelOutputEntry.modelContentProtection
      ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
      : undefined;
    if (
      modelOutputEntry.modelContentProtection &&
      Array.isArray(finalModelContent) &&
      finalModelContent.some((block) => block.type === "image") &&
      !modelContentProtection
    ) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Official CUA frame failed final model-content attestation",
        { recoverable: true },
      );
    }

    const result: ToolExecutionResult = withTerminalToolTurnStop(
      {
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
        success: true,
        output,
        display,
        modelContent: finalModelContent,
        ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
        performance: perf,
        serialization,
        durationMs,
        startedAt: new Date(startTime),
        completedAt: new Date(),
      },
      { entry },
    );

    await emitToolCallResult(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      serialization,
      durationMs,
      display,
      perf,
      skillTelemetryMetadata,
      output,
    );

    await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

    deps.logger?.info("Tool call completed", {
      ...traceContextToLogContext(traceContext),
      durationMs,
      event: "tool.call.completed",
      module: "core.tool.executor",
      status: "completed",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    telemetry?.setOutputBytes(serialization.returnedBytes);
    telemetry?.setOutputTruncated(serialization.truncated);
    telemetry?.finishCompleted();
    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const failureHookResult = await runPostToolUseFailureHooks(
      deps,
      canonicalToolCall,
      executionInput,
      error,
      traceContext,
      options?.signal,
    );
    let result = createErrorResult(
      canonicalToolCall,
      error instanceof Error ? error : new Error(String(error)),
      durationMs,
    );
    const baseModelContent = result.error
      ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
        ? result.modelContent
        : result.error.message
      : undefined;
    if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
      result.modelContent = [
        baseModelContent,
        formatHookAdditionalContexts([
          ...preToolHookResult.additionalContexts,
          ...failureHookResult.additionalContexts,
        ]),
      ].join("\n\n");
    } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
      result.modelContent = [
        baseModelContent,
        formatHookAdditionalContexts(preToolHookResult.additionalContexts),
      ].join("\n\n");
    }
    result = withAutomationCreateLimitTurnStop(result, {
      error,
      toolName: canonicalToolCall.name,
    });

    // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
    // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
    await emitToolCallError(
      deps,
      canonicalToolCall.id,
      traceContext,
      turnId,
      result.error,
      skillTelemetryMetadata,
    );

    deps.logger?.error(
      "Tool call failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        durationMs,
        event: "tool.call.failed",
        module: "core.tool.executor",
        status: "failed",
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
      },
    );

    if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
      telemetry?.finishCancelled("abort_signal");
    } else {
      telemetry?.finishFailed(
        failureStage,
        errorCategoryForToolError(result.error?.type),
        // 原始异常只交给 Telemetry 做受控脱敏；result.error 是面向业务协议重新包装后的错误，
        // 不能覆盖 Trace 中用于定位根因的 source message/type/code。
        error,
      );
    }
    return result;
  } finally {
    if (!handlerStarted) releaseOperation?.();
    unlinkParentAbort();
  }
}
