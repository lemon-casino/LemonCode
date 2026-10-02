import { CompactTrigger, traceContextToLogContext, TurnMachineImpl } from "../deps.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";
import { createCompactRapidRefillError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome, RegularTurnLoopState } from "./turn-loop-state.js";
import {
  evaluateRapidRefill,
  filterTurnRecallOverlayEntries,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
  withTurnRecallOverlaysDetached,
} from "./turn-loop-state.js";

export async function recoverModelStepAfterContextExceeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  contextError: unknown,
  modelStepIndex: number,
  activeEntries: readonly RuntimeMessageEntry[],
): Promise<boolean> {
  if (state.reactiveCompactAttemptedInCurrentModelStep) {
    return false;
  }

  const rapidRefill = evaluateRapidRefill(state.compactTracking);
  if (rapidRefill.shouldBlock) {
    this.logger?.warn("Reactive compact rapid-refill breaker tripped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "compact.rapid_refill_breaker",
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      modelStepIndex,
      module: "core.runtime",
      status: "failed",
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Reactive,
    });
    throw createCompactRapidRefillError({
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
      toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
    });
  }

  state.reactiveCompactAttemptedInCurrentModelStep = true;
  const compactOutcome = await runReactiveCompactAttempt(this, state, {
    activeEntries,
    contextError,
    modelStepIndex,
    rapidRefillCount: rapidRefill.consecutiveRapidRefills,
  });
  if (compactOutcome !== "compacted") {
    return false;
  }

  recordCompactSuccess(state, rapidRefill);
  recordCompactHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(
    TurnMachineImpl.create(
      this.sessionId,
      this.turnNumber,
      state.input,
      state.traceId,
      state.turnId,
    ).start(),
  );
  return true;
}

export async function runReactiveCompactAttempt(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    activeEntries: readonly RuntimeMessageEntry[];
    contextError: unknown;
    modelStepIndex: number;
    rapidRefillCount: number;
  },
): Promise<CompactAttemptOutcome> {
  return await withTurnRecallOverlaysDetached(state.turnRequestState, async () =>
    runtime.reactiveCompactAfterContextExceeded(
      input.contextError,
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        // captured request 与当前 state 必须同时剥离，否则估算或 canonical replacement 仍会固化 recall。
        activeEntries: filterTurnRecallOverlayEntries(input.activeEntries),
        modelStepIndex: input.modelStepIndex,
        rapidRefillCount: input.rapidRefillCount,
        model: state.model,
        turnRequestState: state.turnRequestState,
      },
    ),
  );
}
