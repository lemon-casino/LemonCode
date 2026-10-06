import {
  CoreErrorType,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
} from "@lcode/contracts";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
} from "./errors.js";
import { emitToolCallError } from "./events.js";
import { runPreToolUseHooks } from "./hook-flow.js";
import { resolveToolPermission } from "./permission-flow.js";
import { runToolCallWithTelemetry } from "./telemetry.js";
import { withPlanExitDeniedTurnStop, withWorkflowRefineDeniedFollowUp } from "./turn-control.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput } from "./validation.js";
import { resolveToolEntryModelContract } from "../model-contract.js";
import {
  appendPreToolAdditionalContextsToErrorResult,
  errorCategoryForToolError,
} from "./call-result-policy.js";
import { executeAdmittedToolHandler } from "./call-handler-execution.js";

export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  const totalStartedAt = Date.now();
  const entry = isEmptyToolName(toolCall.name) ? undefined : deps.registry.get(toolCall.name);
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // 隐私与基数边界：未注册工具名来自模型输出，不能假定是受控枚举。
  // 业务错误仍保留真实名称供模型自修复，远端 Trace 统一落入固定 unknown 桶。
  const telemetryToolCall = entry ? canonicalToolCall : { ...toolCall, name: "unknown" };
  return runToolCallWithTelemetry(deps, telemetryToolCall, options, (telemetry) =>
    executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options, telemetry),
  );
}

async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    if (emptyToolName) {
      // 空名在 admission 阶段停止会让模型永远收不到配对结果。复用
      // registry-miss 生命周期，但 provider 内容严格保留模型返回的原始空白名称。
      result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    }
    // registry miss 发生在 handler/ToolCallStarted 之前；旧代码只把失败
    // 返回给 provider，没有发布 ToolCallError，V4 tool row 因而永久停在 inputStreaming。
    await emitToolCallError(deps, toolCall.id, traceContext, turnId, result.error);
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    telemetry?.finishFailed("lookup", "configuration", result.error);
    return result;
  }

  const mode = deps.getMode();

  if (options?.signal?.aborted) {
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
    );
    telemetry?.finishCancelled("abort_signal");
    return result;
  }

  // 解析失败的 {} 只是安全占位；不得让 runtime schema 默认值/preprocess 将它接纳。
  const preparedInitialInput =
    canonicalToolCall.inputError === undefined
      ? prepareInitialToolExecutionInput({
          entry,
          input: canonicalToolCall.input,
          logger: deps.logger,
        })
      : { input: canonicalToolCall.input };
  let executionInput = preparedInitialInput.input;
  const initialInputValidation = validateInitialModelToolInput(
    executionInput,
    entry,
    preparedInitialInput.runtimeValidationIssues,
    canonicalToolCall.inputError,
  );
  if (initialInputValidation) {
    const result = createErrorResult(canonicalToolCall, initialInputValidation);
    // schema 失败与 registry miss 同属 handler/ToolCallStarted 之前的早退；旧代码
    // 只把失败回灌模型，没有发布 ToolCallError，V4 tool row 因而在整个 turn 里停在
    // inputStreaming（CreateWorkflow 卡持续显示「正在编写工作流」），模型重试后又叠一张。
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
    telemetry?.finishFailed("validation", "parse", result.error);
    return result;
  }

  const toolInputValidation = entry.validateInput?.(executionInput, {
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
  });
  if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
    // tool-specific 语义校验原先只能放在 handler，导致无效调用仍先执行
    // PreToolUse、权限和 failure hook；语义校验必须在 hook 前结束。
    const result = createErrorResult(
      canonicalToolCall,
      createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
    );
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
    // 工具专属校验以普通失败结果返回，不走 handler 执行的 try/catch 失败收口。
    // 先发出 ToolCallError 更新工具行，再显式标记遥测失败，避免被记录为 abandoned。
    telemetry?.finishFailed("validation", "parse", result.error);
    return result;
  }

  // 归一化：把模型发出的入参换成「将要发生的执行事实」。位置刻意在 hook **之前**——此后
  // hook、权限规则、确认窗载荷、prepareApproval 与 handler 读的都是同一份输入，于是
  // 「策略看得到真正的脚本」「跨版本可见」「确认与执行同字节」三件事一次到位。
  if (entry.resolveInput) {
    const workingDirectory = deps.getWorkingDirectory?.();
    const resolution = await entry.resolveInput(executionInput, {
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
      ...(deps.dynamicWorkflowRunPort === undefined
        ? {}
        : { dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort }),
      ...(deps.modelCatalogPort === undefined ? {} : { modelCatalogPort: deps.modelCatalogPort }),
      sessionId: deps.sessionId,
    });
    if (isToolHandlerFailure(resolution)) {
      // 与 validateInput 同一条生命周期出口：解析不出来是模型该立刻拿回去修的东西，
      // 不该先弹一次注定失败的确认窗。
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, resolution),
      );
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }
    executionInput = resolution.input;
  }

  const preToolHookResult = await runPreToolUseHooks(
    deps,
    canonicalToolCall,
    executionInput,
    entry,
    mode,
    traceContext,
    options?.signal,
  );
  if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
    const result = appendPreToolAdditionalContextsToErrorResult(
      withPlanExitDeniedTurnStop(
        createPermissionErrorResult(
          canonicalToolCall,
          preToolHookResult.hookPermissionDecisionReason ??
            preToolHookResult.stopReason ??
            "Blocked by PreToolUse hook",
          {
            decision: "deny",
            mode,
            reason: preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
            source: "hook.PreToolUse",
          },
        ),
        {
          mode,
          planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
          toolName: canonicalToolCall.name,
        },
      ),
      preToolHookResult.additionalContexts,
    );
    telemetry?.setPermissionDecision("denied");
    telemetry?.finishDenied("policy_denied");
    return result;
  }
  if (preToolHookResult.updatedInput !== undefined) {
    executionInput = normalizeToolExecutionInput({
      entry,
      input: preToolHookResult.updatedInput,
      logger: deps.logger,
      source: "hook",
    });
    const hookInputValidation = validateInput(executionInput, entry);
    if (hookInputValidation) {
      // Hook 修改后的输入校验失败会在 handler 前直接返回，旧分支没有走
      // PreToolUse context 的统一追加逻辑，导致模型只看到 schema error，看不到 Hook
      // 已产生的诊断上下文；与 deny、permission-deny 的提前失败契约不一致。
      const result = appendPreToolAdditionalContextsToErrorResult(
        createErrorResult(canonicalToolCall, hookInputValidation),
        preToolHookResult.additionalContexts,
      );
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }
  }

  const permissionResult = await resolveToolPermission(
    deps,
    canonicalToolCall,
    entry,
    executionInput,
    preToolHookResult,
    mode,
    traceContext,
    options?.signal,
    telemetry,
  );
  if (!permissionResult.allowed) {
    const result = appendPreToolAdditionalContextsToErrorResult(
      withWorkflowRefineDeniedFollowUp(
        withPlanExitDeniedTurnStop(permissionResult.result, {
          mode,
          planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
          toolName: canonicalToolCall.name,
        }),
        { toolName: canonicalToolCall.name },
      ),
      preToolHookResult.additionalContexts,
    );
    if (result.error?.type === CoreErrorType.PermissionDenied) {
      telemetry?.finishDenied("user_denied");
    } else {
      telemetry?.finishFailed(
        "permission",
        errorCategoryForToolError(result.error?.type),
        result.error,
      );
    }
    return result;
  }
  executionInput = permissionResult.executionInput;
  const permissionWaitMs = permissionResult.permissionWaitMs;

  return executeAdmittedToolHandler({
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
  });
}

function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}
