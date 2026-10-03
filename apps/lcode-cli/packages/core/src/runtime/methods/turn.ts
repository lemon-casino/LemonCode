import { beginLocalTurnPreparation } from "@lcode/contracts";
import {
  createChildTraceContext,
  createQueryId,
  createMessageId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import { type RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { clearBrowserTurnState } from "../../repl/browser-turn-state.js";
import { applySubmissionExecutionState } from "./turn-model.js";
import {
  createTurnPhaseTracker,
  prepareTurnExecutionModel,
  persistTurnStartedEvent,
} from "./turn-execution-preparation.js";
import { prepareTurnInput } from "./turn-input-preparation.js";
import { createRegularTurnLoopState } from "./turn-loop-initialize.js";
import { completeRegularTurn } from "./turn-complete.js";
import { completeHookBlockedTurn, failRegularTurn } from "./turn-outcomes.js";
import { acquireCheckoutExecutionLease } from "./checkout-execution-lease.js";
export { executeTurn } from "./runtime-command-submit.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  let shouldRetryTitleGenerationAfterTurn = false;
  let checkoutLease: { release(): Promise<void> } | undefined;
  // 线上“已工作 N 秒”但没有终态的根因候选是：内层 Turn try/catch 之前的 await
  // 拒绝直接穿出。记录当前阶段并区分是否已被内层处理，便于生产日志还原卡点。
  let turnFailureHandled = false;
  const turnPhases = createTurnPhaseTracker(this, turnTraceContext);
  const { start: startTurnPhase, complete: completeTurnPhase } = turnPhases;
  const turnTelemetry = this.agentTelemetry.turn({
    inputSource: options?.inputSource,
    traceContext: turnTraceContext,
    turnNumber: this.turnNumber,
  });

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      checkoutLease = await acquireCheckoutExecutionLease(this, String(turnId), turnAbortSignal);
      throwIfTurnAborted(turnAbortSignal);
      const admittedModel = await prepareTurnExecutionModel.call(
        this,
        {
          admittedModelSelection,
          events,
          options,
          rewindCommand,
          turnAbortSignal,
          turnStartedAtMs,
          turnTraceContext,
        },
        turnPhases,
        () => {
          turnFailureHandled = true;
        },
      );
      let phaseStartedAt: number;

      if (compactInstructions !== null) {
        const compactModel = await applySubmissionExecutionState(
          this,
          options?.intent,
          turnTraceContext,
          options?.modelExecution,
          admittedModel,
        );
        return this.executeManualCompact(
          input,
          compactInstructions,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
          compactModel,
        );
      }
      if (rewindCommand !== null) {
        return this.executeRewindCommand(
          input,
          rewindCommand,
          turnId,
          turnTraceContext,
          turnAbortSignal,
          options?.inputId,
        );
      }
      activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        true,
        options?.inputId === undefined ? {} : { inputId: options.inputId },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      // execution-scoped 临时 Provider（例如闲时任务）拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      const submissionModel = await applySubmissionExecutionState(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
        admittedModel,
      );
      startedTarget = await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      await persistTurnStartedEvent.call(
        this,
        {
          attachments,
          displayInput,
          events,
          executionStartedAt,
          options,
          queryId,
          turnTraceContext,
          userMessageId,
        },
        turnPhases,
      );
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      if (startedTarget && this.sessionStore?.heartbeatTargetRun) {
        targetRunHeartbeat = setInterval(() => {
          void this.trackResidencyBlockingWork(
            this.heartbeatTargetTurnAccounting({
              inputID: targetRunInputID,
              seenAtMs: Date.now(),
              startedTarget,
              traceContext: turnTraceContext,
            }),
          );
        }, TARGET_RUN_HEARTBEAT_MS);
        if (typeof targetRunHeartbeat === "object" && "unref" in targetRunHeartbeat) {
          targetRunHeartbeat.unref();
        }
      }

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          return await completeHookBlockedTurn.call(
            this,
            {
              activeTurn,
              events,
              options,
              startedTarget,
              targetRunInputID,
              traceId,
              turnId,
              turnMachine,
              turnStartedAtMs,
              turnTraceContext,
              userPromptHookResult,
            },
            (machine) => {
              turnMachine = machine;
            },
          );
        }
        shouldRetryTitleGenerationAfterTurn = await prepareTurnInput.call(this, {
          attachments,
          displayInput,
          input,
          options,
          turnAbortSignal,
          turnId,
          turnTraceContext,
          userMessageId,
          userPromptHookResult,
        });

        loopState = createRegularTurnLoopState.call(this, {
          activeTurn,
          admittedModel,
          admittedOutputStyle,
          displayInput,
          events,
          input,
          options,
          submissionModel,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnTraceContext,
          userMessageId,
        });

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        return await completeRegularTurn.call(this, loopState, {
          displayInput,
          options,
          shouldRetryTitleGenerationAfterTurn,
          startedTarget,
          targetRunInputID,
          turnStartedAtMs,
          turnTraceContext,
        });
      } catch (error) {
        turnFailureHandled = true;
        return await failRegularTurn.call(
          this,
          error,
          {
            activeTurn,
            events,
            loopState,
            options,
            startedTarget,
            targetRunInputID,
            turnAbortSignal,
            turnId,
            turnMachine,
            turnStartedAtMs,
            turnTraceContext,
            userMessageId,
          },
          (target) => {
            startedTarget = target;
          },
        );
      }
    }).then(
      (result) => {
        turnTelemetry.finishCompleted("assistant_message");
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhases.phase,
            status: "failed",
          });
        }
        if (isTurnCancellationError(error, turnAbortSignal)) {
          turnTelemetry.finishCancelled("abort_signal");
        } else {
          turnTelemetry.finishFailed("unhandled", "unknown", error);
        }
        throw error;
      },
    );

  return turnTelemetry.run(execute).finally(async () => {
    if (targetRunHeartbeat) {
      clearInterval(targetRunHeartbeat);
    }
    this.releaseTurnStart(turnId);
    clearBrowserTurnState(this.sessionId, turnId);
    this.finishActiveTurn(activeTurn);
    turnAbortScope.dispose();
    try {
      await this.browserControlPort?.turnEnded?.({
        sessionId: this.sessionId,
        turnId: String(turnId),
        traceContext: turnTraceContext,
      });
    } catch (error) {
      // 生命周期清理失败不能覆盖已经完成/失败的主 turn；backend 会在 session close 再兜底释放。
      this.logger?.warn("Browser turn cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.turn_cleanup.failed",
        turnId: String(turnId),
      });
    }
    await checkoutLease?.release();
  });
}
