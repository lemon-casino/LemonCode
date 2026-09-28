import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";

export async function recordGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  input: {
    text: string;
    traceContext?: TraceContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const activeTurn = this.activeTurn;
  if (
    activeTurn?.kind === "regular" &&
    activeTurn.goalStateChangeReminderDeferralOpen
  ) {
    // Stop 会先暂停 goal、再 abort 正在执行的工具。此处若立即写 history，
    // reminder 会落在 tool_use 与 cancelled tool_result 之间，导致下一次请求违反 provider grammar。
    activeTurn.pendingGoalStateChangeReminder = { text: input.text };
    return;
  }
  await materializeGoalStateChangeReminder.call(this, input.text, traceContext);
}

export function openGoalStateChangeReminderDeferral(
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn?.kind === "regular") {
    activeTurn.goalStateChangeReminderDeferralOpen = true;
  }
}

export async function closeGoalStateChangeReminderDeferral(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
  traceContext: TraceContext,
): Promise<void> {
  if (activeTurn?.kind !== "regular") return;

  // activeTurn 会继续存活到 terminal/accounting 全部结束，不能再用它的
  // 存在与否判断 pending 所有权。先同步关闭，之后到达的 reminder 会直接物化。
  activeTurn.goalStateChangeReminderDeferralOpen = false;
  const pending = activeTurn.pendingGoalStateChangeReminder;
  if (!pending) return;

  activeTurn.pendingGoalStateChangeReminder = undefined;
  try {
    await materializeGoalStateChangeReminder.call(this, pending.text, traceContext);
  } catch (error) {
    // 权威 target 已先落库；reminder 持久化失败不能阻止 Stop turn 发出 terminal event。
    // 保持单次物化，不在 turn 收尾引入 retry、cursor 或额外持久化状态机。
    this.logger?.warn("Failed to materialize pending goal state reminder", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.reminder.materialize.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

async function materializeGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.ensureContextInitialized(traceContext);
  this.messageHistory.addAttachment("goal_state_change", text);
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: this.sessionId,
    source: "goal_state_change",
    text,
    traceContext,
    visibility: "model-only",
  });
}
