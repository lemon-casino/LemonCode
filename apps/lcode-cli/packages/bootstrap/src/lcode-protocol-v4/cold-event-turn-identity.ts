import { SessionEventType, type MessageWithParts, type SessionEvent } from "@lcode/contracts";

import {
  HOOK_LIFECYCLE_EVENT_TYPES,
  stringField,
  stringArrayField,
} from "./cold-event-classification.js";

export function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // startup SessionStart 可能已经携带尚未映射的 runtime turnId；只有后续真实
        // TurnStarted 才能给出 durable product turn。async terminal 若已解析则沿用。
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // model-only 维护 turn（manual /compact、goal continuation）没有资格承载
    // SessionStart 摘要；resume SessionStart 必须等下一条 user-visible 真实 turn 归位。
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // resume SessionStart 在 Runtime 中先于下一条真实 TurnStarted；cold merge 必须沿
    // 同一事件顺序建立归属，不能把它追加到历史末尾或由 Renderer 猜最近一轮。
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}

function eventMessageIds(event: SessionEvent): string[] {
  const ids = [
    stringField(event.payload, "messageId"),
    stringField(event.payload, "assistantMessageId"),
  ].filter((id): id is string => id !== null);
  ids.push(...stringArrayField(event.payload, "injectedMessageIds"));
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const drainedInputs = (event.payload as Record<string, unknown>).drainedInputs;
    if (Array.isArray(drainedInputs)) {
      for (const input of drainedInputs) {
        const messageId = stringField(input, "messageId");
        if (messageId) ids.push(messageId);
      }
    }
  }
  return ids;
}

/**
 * 只靠持久实体 ID 建立 transcript message → hydration turn 映射。
 * assistant 没有 text part 时可能不直接产 assistantMessageId，因此再用持久的
 * parentID / anchor.turnId 传播；禁止用文本或时间邻近猜测轮归属。
 */
export function durableTurnByMessageId(
  messages: readonly MessageWithParts[],
  events: readonly SessionEvent[],
): Map<string, string> {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId) continue;
    for (const messageId of eventMessageIds(event)) {
      turnByMessageId.set(messageId, String(event.turnId));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const turnByRuntimeAnchor = new Map<string, string>();
    for (const message of messages) {
      const turnId = turnByMessageId.get(String(message.info.id));
      const runtimeAnchor = message.info.anchor?.turnId;
      if (turnId && runtimeAnchor) turnByRuntimeAnchor.set(String(runtimeAnchor), turnId);
    }
    for (const message of messages) {
      const messageId = String(message.info.id);
      if (turnByMessageId.has(messageId)) continue;
      const parentTurn =
        message.info.role === "assistant" && message.info.parentID
          ? turnByMessageId.get(String(message.info.parentID))
          : undefined;
      const anchorTurn = message.info.anchor?.turnId
        ? turnByRuntimeAnchor.get(String(message.info.anchor.turnId))
        : undefined;
      const turnId = parentTurn ?? anchorTurn;
      if (!turnId) continue;
      turnByMessageId.set(messageId, turnId);
      changed = true;
    }
  }
  return turnByMessageId;
}

/**
 * Hook lifecycle 只携带 runtime turnId，没有持久 messageId；cold transcript 则会
 * 重新生成 hydrate-turn-*。这里只使用持久 message anchor 建立无歧义身份映射，
 * 禁止按文本或时间邻近猜测。若同一 runtime anchor 指向多个 hydration turn，宁可
 * 保留原事件等待显式恢复边界，也不能把 Hook 错挂到另一轮。
 */
export function durableTurnByRuntimeAnchor(
  messages: readonly MessageWithParts[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByRuntimeAnchor = new Map<string, string>();
  const ambiguousRuntimeAnchors = new Set<string>();
  for (const message of messages) {
    const runtimeAnchor = message.info.anchor?.turnId;
    const durableTurnId = turnByMessageId.get(String(message.info.id));
    if (!runtimeAnchor || !durableTurnId) continue;
    const runtimeTurnId = String(runtimeAnchor);
    if (ambiguousRuntimeAnchors.has(runtimeTurnId)) continue;
    const existing = turnByRuntimeAnchor.get(runtimeTurnId);
    if (existing && existing !== durableTurnId) {
      turnByRuntimeAnchor.delete(runtimeTurnId);
      ambiguousRuntimeAnchors.add(runtimeTurnId);
      continue;
    }
    turnByRuntimeAnchor.set(runtimeTurnId, durableTurnId);
  }
  return turnByRuntimeAnchor;
}

/**
 * queue drain 可在同一 runtime turn 内切出多个 product turn；Hook 仍只携带
 * runtime turnId，因此必须按事件顺序跟随持久 message boundary。首次 lifecycle
 * 一旦解析成功就冻结 invocation 归属，避免后台 terminal 跨 boundary 后改挂。
 */
export function durableHookTurnByInvocationId(
  events: readonly SessionEvent[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const currentTurnByRuntimeId = new Map<string, string>();
  const runtimeTurnByPendingInputId = new Map<string, string>();
  const runtimeTurnByInvocationId = hookInvocationTurnIds(events);
  const durableTurnByInvocationId = new Map<string, string>();

  const advance = (runtimeTurnId: string | null, messageId: string | null): void => {
    if (!runtimeTurnId || !messageId) return;
    const durableTurnId = turnByMessageId.get(messageId);
    if (durableTurnId) currentTurnByRuntimeId.set(runtimeTurnId, durableTurnId);
  };

  for (const event of events) {
    if (event.type === SessionEventType.TurnStarted) {
      advance(event.turnId ? String(event.turnId) : null, stringField(event.payload, "messageId"));
    } else if (event.type === SessionEventType.TurnSteerDrained) {
      const runtimeTurnId =
        stringField(event.payload, "targetTurnId") ?? (event.turnId ? String(event.turnId) : null);
      const drainedInputs =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).drainedInputs
          : undefined;
      if (runtimeTurnId && Array.isArray(drainedInputs)) {
        for (const input of drainedInputs) {
          const pendingInputId = stringField(input, "pendingInputId");
          if (pendingInputId) runtimeTurnByPendingInputId.set(pendingInputId, runtimeTurnId);
          if (stringField(input, "delivery") !== "guide") {
            advance(runtimeTurnId, stringField(input, "messageId"));
          }
        }
      }
    } else if (event.type === SessionEventType.SessionInputPromoted) {
      const pendingInputId = stringField(event.payload, "pendingInputId");
      const runtimeTurnId = event.turnId
        ? String(event.turnId)
        : pendingInputId
          ? (runtimeTurnByPendingInputId.get(pendingInputId) ?? null)
          : null;
      advance(runtimeTurnId, stringField(event.payload, "messageId"));
    }

    if (!HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const invocationId = stringField(event.payload, "hookInvocationId");
    if (!invocationId || durableTurnByInvocationId.has(invocationId)) continue;
    const runtimeTurnId =
      runtimeTurnByInvocationId.get(invocationId) ??
      (event.turnId ? String(event.turnId) : undefined);
    const durableTurnId = runtimeTurnId ? currentTurnByRuntimeId.get(runtimeTurnId) : undefined;
    if (durableTurnId) durableTurnByInvocationId.set(invocationId, durableTurnId);
  }
  return durableTurnByInvocationId;
}
