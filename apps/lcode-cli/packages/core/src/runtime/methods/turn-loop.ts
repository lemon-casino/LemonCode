import { beginLocalTurnPreparation } from "@lcode/contracts";
import {
  CompactPhase,
  CompactReason,
  CoreErrorType,
  createCoreError,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  evaluateRapidRefill,
  filterTurnRecallOverlayEntries,
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  OFF_PEAK_MUTATION_TOOL_NAMES,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
  withTurnRecallOverlaysDetached,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";
import { activateExecutionFailoverAtSafeBoundary } from "./model-failover-router.js";
import { ProjectMemoryRecallIndex } from "../../memory/recall/index.js";
import { appendSessionHistoryRecallForTurn } from "./turn-session-history-recall.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    // 这是跨供应商交接的唯一健康路径：上一 model-step（含完整工具批次）已结束，
    // 下一请求尚未组装。UI command 本身绝不改正在使用的 model。
    const failoverActivation = await activateExecutionFailoverAtSafeBoundary(this, state);
    if (failoverActivation === "blocked") {
      const target = this.executionFailoverPolicyPort.resolve(
        this.executionFailoverScope ?? {
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
        },
      );
      // 已投影 blocked 后不能继续拿旧 A 请求；否则 UI 显示切换失败，实际执行却静默回退。
      throw createCoreError(
        CoreErrorType.ModelError,
        "Requested model switch could not be activated",
        {
          context: {
            code: "execution_failover_target_blocked",
            ...(target
              ? {
                  modelId: target.modelSelection.modelId,
                  providerId: target.modelSelection.providerId,
                }
              : {}),
          },
          recoverable: true,
        },
      );
    }
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    await compactTurnRequestBeforeModelStep(this, state);
    throwIfTurnAborted(state.turnAbortSignal);

    await appendProjectMemoryRecallForTurn(this, state);
    throwIfTurnAborted(state.turnAbortSignal);

    await appendSessionHistoryRecallForTurn(this, state);
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const tools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
    finishTools();
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    const {
      latestRealUserMessageIndex,
      messages,
      recordedMessages,
      requestEntries,
      sourceEntries,
    } = beginTurnModelRequest(this, state);

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex,
      messages,
      sourceEntries,
      requestEntries,
      recordedMessages,
      tools,
    });

    if (result === "break") {
      break;
    }
  }
}

export async function compactTurnRequestBeforeModelStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  const compactPhase = state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
  await withTurnRecallOverlaysDetached(state.turnRequestState, async () => {
    await runtime.microcompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        model: state.model,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        turnRequestState: state.turnRequestState,
      },
    );
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await runtime.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
  });
}

export function beginTurnModelRequest(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const requestEntries = [...state.turnRequestState.entries];
  // provider-visible user ordering projection 会改变最终 latest user 落点，
  // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
  const providerProjection = buildRuntimeProviderRequestMessages(runtime, {
    entries: requestEntries,
    applyCacheControl: true,
    model: state.model,
  });
  const recordableEntries = filterTurnRecallOverlayEntries(
    filterOutputTokenContinuationEntries(requestEntries),
  );
  const recordableProjection =
    recordableEntries === requestEntries
      ? providerProjection
      : buildRuntimeProviderRequestMessages(runtime, {
          entries: recordableEntries,
          applyCacheControl: true,
          model: state.model,
        });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.startModelRequest(
      `${state.model.providerId}/${state.model.modelId}`,
      recordableProjection.messages,
    ),
  );

  return {
    latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
    messages: providerProjection.messages,
    recordedMessages: recordableProjection.messages,
    requestEntries,
    sourceEntries: providerProjection.sourceEntries,
  };
}

export async function appendProjectMemoryRecallForTurn(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  if (
    state.memoryRecallAttempted ||
    state.modelStepCount !== 0 ||
    state.turnRequestState.outputTokenContinuationCount > 0
  ) {
    return;
  }

  // attempt 必须先于任何 I/O 落位；否则失败重试或 provider failover 会重复扫描与注入。
  state.memoryRecallAttempted = true;
  const query = state.turnRecallQuery?.trim();
  if (!query || !runtime.memoryRoot || !runtime.fileSystemPort) return;

  const startedAt = Date.now();
  runtime.projectMemoryRecallIndex ??= new ProjectMemoryRecallIndex();
  try {
    const outcome = await runtime.projectMemoryRecallIndex.recall({
      fileSystem: runtime.fileSystemPort,
      query,
      rootDir: runtime.memoryRoot,
      signal: state.turnAbortSignal,
      traceContext: state.turnTraceContext,
    });
    if (outcome.attachment) {
      appendTurnRequestEntries(state.turnRequestState, [
        systemReminderAttachmentEntry("memory_recall", outcome.attachment),
      ]);
    }
    runtime.logger?.debug("Project memory recall completed", {
      ...traceContextToLogContext(state.turnTraceContext),
      candidateCount: outcome.candidateCount,
      durationMs: Date.now() - startedAt,
      event: "memory.recall.completed",
      indexedCount: outcome.indexedCount,
      matchCount: outcome.matchCount,
      module: "core.runtime",
      outputCharacterCount: outcome.attachment?.length ?? 0,
    });
  } catch (error) {
    if (state.turnAbortSignal.aborted) return;
    // Recall 是可恢复的辅助上下文：扫描失败不能阻断用户主 turn，也不能回退注入整库正文。
    runtime.logger?.warn("Project memory recall failed", {
      ...traceContextToLogContext(state.turnTraceContext),
      durationMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "memory.recall.failed",
      module: "core.runtime",
    });
  }
}

function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  if (isOffPeakCreateRestrictedTurn(state)) {
    // 闲时执行轮禁止再创建闲时任务（防递归自我派生）；OffPeakList 只读保留。
    // 注意 automation 执行轮不进此分支——cron turn 放行 OffPeakCreate。
    for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
