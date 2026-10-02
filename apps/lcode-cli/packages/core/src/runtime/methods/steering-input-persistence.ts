import type { AgentRuntimeInternal } from "../internal.js";

export async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // 只删内存 queue/event 会留下 admitted 的 durable session_input。
  // LRU 淘汰后 commands/query 会退成 unknown，CLI restart 又会把用户主动删除误报为
  // inputDiscardedOnRestart。先写 cancelled 终态，失败时不允许 UI queue 先消失。
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

export async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}
