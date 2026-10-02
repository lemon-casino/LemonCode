import { beginLocalTurnPreparation, type LocalTtftDetail } from "@lcode/contracts";
import { HookEventName, SessionEventType, traceContextToLogContext } from "../deps.js";
import type { MessageId, QueryId, SessionEvent, TurnState } from "../deps.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  appendTurnOutcomeEvent,
  summarizeTurnAttachmentsForEvent,
} from "../helpers/index.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createTurnModel } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { refreshProjectMemoryIndex } from "../helpers/project-memory-index-refresh.js";
import {
  blockExecutionFailoverTargetForModelCreationFailure,
  modelSelectionFromModel,
} from "./model-failover-router.js";
import type { Model, ModelSelection, TraceContext } from "../deps.js";
import type { ParsedRewindCommand } from "../types.js";

export interface TurnPhaseTracker {
  start(phase: string): number;
  complete(phase: string, startedAt: number): void;
  readonly phase: string;
}

export function createTurnPhaseTracker(
  runtime: Pick<AgentRuntimeInternal, "logger">,
  turnTraceContext: TraceContext,
): TurnPhaseTracker {
  let turnPhase = "queued";
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    runtime.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    runtime.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };

  return {
    start: startTurnPhase,
    complete: completeTurnPhase,
    get phase() {
      return turnPhase;
    },
  };
}

export async function prepareTurnExecutionModel(
  this: AgentRuntimeInternal,
  preparation: {
    admittedModelSelection: ModelSelection | undefined;
    events: SessionEvent[];
    options: ExecuteTurnOptions | undefined;
    rewindCommand: ParsedRewindCommand | null;
    turnAbortSignal: AbortSignal;
    turnStartedAtMs: number;
    turnTraceContext: TraceContext;
  },
  phases: TurnPhaseTracker,
  onModelCreationFailure: () => void,
): Promise<Model | undefined> {
  const {
    admittedModelSelection,
    events,
    options,
    rewindCommand,
    turnAbortSignal,
    turnStartedAtMs,
    turnTraceContext,
  } = preparation;
  const { start: startTurnPhase, complete: completeTurnPhase } = phases;
  if (this.executionFailoverScope?.backgroundWorkId) {
    if (this.executionFailoverScopeLifetime === "turn" || !this.executionFailoverScopeRetained) {
      await this.executionFailoverPolicyPort.retain({
        ...(admittedModelSelection ? { currentSelection: admittedModelSelection } : {}),
        lifetime: this.executionFailoverScopeLifetime,
        scope: this.executionFailoverScope,
        traceContext: turnTraceContext,
      });
      this.executionFailoverScopeRetained = true;
    }
  }
  let admittedModel;
  try {
    admittedModel =
      rewindCommand === null
        ? createTurnModel(this, {
            requestDependencies: options?.modelExecution?.requestDependencies,
            selection: admittedModelSelection,
          })
        : undefined;
  } catch (error) {
    if (admittedModelSelection) {
      try {
        await blockExecutionFailoverTargetForModelCreationFailure(
          this,
          admittedModelSelection,
          turnTraceContext,
        );
      } catch (policyError) {
        // failover 状态持久化失败不能吞掉原始模型创建错误；Turn 仍必须形成明确终态。
        this.logger?.warn("Execution failover target could not be marked blocked", {
          errorMessage: policyError instanceof Error ? policyError.message : String(policyError),
          event: "model.failover.target_block_persist_failed",
          module: "core.runtime",
        });
      }
    }
    // 同步滞后/模型失效可在内层 Turn try 之前创建失败。只写日志会让已接纳输入
    // 没有终态、桌面与手机都看不到错误；复用 outcome，不等待同步、不改原选择。
    onModelCreationFailure();
    const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
    await appendTurnOutcomeEvent(this, {
      coreError,
      events,
      durationMs: Date.now() - turnStartedAtMs,
      turnPhase: "model_creation",
      inputId: options?.inputId,
      traceContext: turnTraceContext,
      fallbackMessage: "Model creation failed",
      logEvent: "turn.failed",
      logLabel: "Turn",
    });
    throw coreError;
  }
  if (this.executionFailoverScope?.backgroundWorkId && admittedModel) {
    await this.executionFailoverPolicyPort.retain({
      currentSelection: modelSelectionFromModel(admittedModel),
      lifetime: this.executionFailoverScopeLifetime,
      scope: this.executionFailoverScope,
      traceContext: turnTraceContext,
    });
  }
  let phaseStartedAt = startTurnPhase("context_initialization");
  if (this.contextInitialized) {
    // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
    // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
    await refreshProjectMemoryIndex(this, turnAbortSignal);
    rebuildContextPrefix(this, { model: admittedModel });
  } else {
    // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
    // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
    await this.ensureContextInitialized(turnTraceContext, admittedModel);
  }
  completeTurnPhase("context_initialization", phaseStartedAt);
  throwIfTurnAborted(turnAbortSignal);
  phaseStartedAt = startTurnPhase("session_start_hooks");
  const sessionStartHookResult = await this.runSessionStartHooks(
    "startup",
    turnTraceContext,
    turnAbortSignal,
    admittedModel,
  );
  completeTurnPhase("session_start_hooks", phaseStartedAt);
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );

  return admittedModel;
}

export async function persistTurnStartedEvent(
  this: AgentRuntimeInternal,
  input: {
    attachments: TurnState["attachments"];
    displayInput: string;
    events: SessionEvent[];
    executionStartedAt: number;
    options: ExecuteTurnOptions | undefined;
    queryId: QueryId;
    turnTraceContext: TraceContext;
    userMessageId: MessageId;
  },
  phases: TurnPhaseTracker,
): Promise<void> {
  const {
    attachments,
    displayInput,
    events,
    executionStartedAt,
    options,
    queryId,
    turnTraceContext,
    userMessageId,
  } = input;
  const { start: startTurnPhase, complete: completeTurnPhase } = phases;
  // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
  // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
  // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
  const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
  const turnStartedEvent = this.createEvent(
    SessionEventType.TurnStarted,
    {
      executionStartedAt,
      turnNumber: this.turnNumber,
      input: displayInput,
      messageId: userMessageId,
      inputId: options?.inputId,
      ...(options?.automationId
        ? { automationId: options.automationId }
        : options?.offPeakTaskId
          ? {
              offPeakTaskId: options.offPeakTaskId,
              ...(options.offPeakRunType ? { offPeakRunType: options.offPeakRunType } : {}),
            }
          : {}),
      foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
      queryId,
      inputSource: options?.inputSource,
      inputVisibility: options?.inputVisibility,
      originMeta: options?.originMeta,
      ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
      targetId: options?.targetId,
      ...(options?.intent ? { intent: options.intent } : {}),
      ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
    },
    turnTraceContext,
  );
  const phaseStartedAt = startTurnPhase("turn_started_event");
  await this.appendEvent(turnStartedEvent, turnTraceContext);
  completeTurnPhase("turn_started_event", phaseStartedAt);
  events.push(turnStartedEvent);
}
