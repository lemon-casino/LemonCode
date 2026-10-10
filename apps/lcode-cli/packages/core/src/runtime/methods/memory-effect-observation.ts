import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  memoryEffectVerification,
  memoryEffectWorkspaceKey,
} from "../../memory/effect-observation.js";

export async function recordMemoryEffectTurn(
  runtime: AgentRuntimeInternal,
  input: {
    state?: RegularTurnLoopState;
    events: readonly SessionEvent[];
    status: "completed" | "error" | "cancelled";
  },
): Promise<void> {
  const state = input.state;
  const rootDir = runtime.memoryRoot;
  const effects = runtime.fileSystemPort?.projectMemory?.effects;
  if (
    runtime.config.memory?.observationEnabled !== true ||
    runtime.config.memory.enabled === false ||
    runtime.config.memory.use === false ||
    !rootDir ||
    !effects ||
    !state?.memoryEffectInjection?.length ||
    !state.turnRecallQuery
  )
    return;
  const workspaceKey = memoryEffectWorkspaceKey(
    runtime.config.memory.workspaceIdentity,
    runtime.workspaceRoot,
  );
  if (
    !state.memoryEffectScope ||
    state.memoryEffectScope.rootDir !== rootDir ||
    state.memoryEffectScope.workspaceKey !== workspaceKey ||
    !input.events.some(
      (event) =>
        event.sessionId === runtime.sessionId &&
        event.turnId === state.turnId &&
        event.type === SessionEventType.ModelRequest,
    )
  )
    return;
  try {
    // 主请求取消后仍记录已发生的 injection/cancelled 事实；不把已取消 signal 传给收尾写入。
    const result = await effects.recordTurn(
      {
        rootDir,
        turn: {
          schemaVersion: 1,
          workspaceKey,
          sessionId: runtime.sessionId,
          turnId: state.turnId,
          ...(state.userMessageId ? { sourceMessageId: state.userMessageId } : {}),
          observedAt: Date.now(),
          status: input.status,
          ...memoryEffectVerification(input.events, runtime.sessionId, state.turnId),
          entries: state.memoryEffectInjection,
        },
      },
      { trace: state.turnTraceContext },
    );
    if (result === "full")
      runtime.logger?.warn("Memory observation capacity is full", {
        event: "memory.effects.full",
        module: "core.runtime",
      });
  } catch (error) {
    runtime.logger?.warn("Memory observation unavailable", {
      event: "memory.effects.unavailable",
      module: "core.runtime",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

/** Goal verifier finishes after ordinary turn settlement; append a referenced fact instead of rewriting the initial observation. */
export async function observeMemoryVerificationEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): Promise<void> {
  const rootDir = runtime.memoryRoot;
  const effects = runtime.fileSystemPort?.projectMemory?.effects;
  if (
    event.type !== SessionEventType.TargetCompletionVerification ||
    runtime.config?.memory?.observationEnabled !== true ||
    runtime.config.memory.enabled === false ||
    runtime.config.memory.use === false ||
    !rootDir ||
    !effects ||
    event.sessionId !== runtime.sessionId
  )
    return;
  const payload = event.payload as { status?: unknown; anchorTurnId?: unknown };
  if (
    !payload ||
    !["completed", "cancelled", "failed_open", "failed_closed"].includes(String(payload.status))
  )
    return;
  const turnId = typeof payload.anchorTurnId === "string" ? payload.anchorTurnId : event.turnId;
  if (!turnId) return;
  const verdict = memoryEffectVerification([event], runtime.sessionId, turnId);
  await effects.recordVerification({
    rootDir,
    verification: {
      schemaVersion: 1,
      workspaceKey: memoryEffectWorkspaceKey(
        runtime.config.memory.workspaceIdentity,
        runtime.workspaceRoot,
      ),
      sessionId: runtime.sessionId,
      turnId,
      evidenceId: event.id,
      recordedAt: event.timestamp.getTime(),
      verification: verdict.verification,
      basis: verdict.verificationBasis ?? "model",
    },
  });
}
