import { SessionEventType, type MessageWithParts, type SessionEvent } from "@lcode/contracts";

import { stringField, stringArrayField } from "./cold-event-classification.js";

export function memoryAuthorityTurnIds(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
): { ambiguousLegacyStarts: SessionEvent[]; turnIds: Set<string> } {
  const started = new Map<string, SessionEvent>();
  const terminal = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ? String(event.turnId) : null;
    if (!turnId) continue;
    if (event.type === SessionEventType.TurnStarted) started.set(turnId, event);
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      terminal.add(turnId);
    }
  }

  const persistedMessageIds = new Set(messages.map((message) => String(message.info.id)));
  const persistedTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const authority = new Set<string>();
  const ambiguousLegacyStarts: SessionEvent[] = [];
  for (const [turnId, start] of started) {
    if (!terminal.has(turnId)) {
      authority.add(turnId);
      continue;
    }
    const messageId = stringField(start.payload, "messageId");
    const hasDurableStarter =
      (messageId !== null && persistedMessageIds.has(messageId)) || persistedTurnIds.has(turnId);
    if (!hasDurableStarter) {
      authority.add(turnId);
      if (messageId === null) ambiguousLegacyStarts.push(start);
    }
  }
  return { ambiguousLegacyStarts, turnIds: authority };
}

export function resumedSubagentLifecycleEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const keep = new Set<number>();
  const resumedAgentIds = new Set<string>();
  events.forEach((event, index) => {
    const agentId = stringField(event.payload, "agentId");
    if (!agentId) return;
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.resumed === true) {
        resumedAgentIds.add(agentId);
        keep.add(index);
      }
      return;
    }
    if (event.type === SessionEventType.SubagentStopped && resumedAgentIds.has(agentId)) {
      keep.add(index);
    }
  });
  return keep;
}

export function queueStateEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const queuedLifecycleById = new Map<string, number[]>();
  const latestDispatchById = new Map<string, number>();
  const latestDeliveryChangeById = new Map<string, number>();
  const pendingIds = new Set<string>();
  let latestReorder: number | null = null;
  let latestAutoDrain: number | null = null;
  let latestFollowupMode: number | null = null;

  events.forEach((event, index) => {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.add(id);
        const lifecycle = queuedLifecycleById.get(id) ?? [];
        lifecycle.push(index);
        queuedLifecycleById.set(id, lifecycle);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDispatchChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDispatchById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDeliveryChangeById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerReordered) latestReorder = index;
    if (event.type === SessionEventType.QueueAutoDrainChanged) latestAutoDrain = index;
    if (event.type === SessionEventType.FollowupModeChanged) latestFollowupMode = index;
  });

  const keep = new Set<number>();
  for (const id of pendingIds) {
    const queuedLifecycle = queuedLifecycleById.get(id) ?? [];
    const dispatch = latestDispatchById.get(id);
    const deliveryChange = latestDeliveryChangeById.get(id);
    // editQueueItem 在旧事件里可能只重发新 text，完整 intent/附件/来源
    // 仍只在首次 queued 事件。从空投影 cold replay 时必须保留该 id
    // 自最近一次 admission 起的全部 queued 生命周期，让 reducer 原地合并字段。
    for (const queued of queuedLifecycle) keep.add(queued);
    const latestQueued = queuedLifecycle.at(-1) ?? -1;
    if (dispatch !== undefined && dispatch > latestQueued) keep.add(dispatch);
    if (deliveryChange !== undefined && deliveryChange > latestQueued) keep.add(deliveryChange);
  }
  if (latestReorder !== null && pendingIds.size > 0) keep.add(latestReorder);
  if (latestAutoDrain !== null) keep.add(latestAutoDrain);
  if (latestFollowupMode !== null) keep.add(latestFollowupMode);
  return keep;
}

export function setupModelEventIndexes(
  events: readonly SessionEvent[],
  authorityTurnIds: ReadonlySet<string>,
  messages: readonly MessageWithParts[],
): Set<number> {
  const keep = new Set<number>();
  let latestModelSelected: number | null = null;
  events.forEach((event, index) => {
    if (event.type === SessionEventType.ModelSelected) latestModelSelected = index;
    if (
      event.type === SessionEventType.TurnStarted &&
      event.turnId &&
      authorityTurnIds.has(String(event.turnId)) &&
      latestModelSelected !== null
    ) {
      keep.add(latestModelSelected);
    }
  });
  if (messages.length === 0 && latestModelSelected !== null) keep.add(latestModelSelected);
  return keep;
}
