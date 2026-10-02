// 子会话生命周期行与原 Agent 创建锚点的归并。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent } from "@lcode/contracts";
import type {
  ConversationDelta,
  SubagentRow,
  BackgroundWorkSummary,
} from "@lcode/shared/lcode-protocol-v4";
import { ms, rowBase, turnIdOf, findSubagentRow } from "./product-projection-rows.js";

type SubagentSpawnedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "subagentRowIdByAgentId"
  | "backgroundLifecycleByWorkId"
  | "consumedBackgroundLifecycles"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

type ResumedSubagentBackgroundWorkDeltaHost = Pick<
  ProductProjectionState,
  "snapshot" | "backgroundLifecycleByWorkId" | "consumedBackgroundLifecycles"
>;

type SubagentMessageHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "subagentRowIdByAgentId"
>;

type SubagentStoppedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "subagentRowIdByAgentId"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

type FindSubagentLifecycleRowHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "subagentRowIdByAgentId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

// ── subagent 行镜像──
// schema/UI 已有 subagent row，但旧 reducer 未消费 Subagent* 事件；
// cold hydration 即使合成事件也无法恢复下钻行。这里让 live/cold 共用同一状态机。

export function onSubagentSpawned(
  host: SubagentSpawnedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = subagentAgentId(payload, event);
  const existing = findSubagentLifecycleRow(host, agentId, payload, event);
  if (existing) host.subagentRowIdByAgentId.set(agentId, existing.rowId);
  const childSessionId = stringPayload(payload, "childSessionId");
  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  const resumedBackgroundWork = resumedSubagentBackgroundWorkDelta(
    host,
    event,
    payload,
    agentId,
    childSessionId,
  );
  if (
    existing?.status === "running" &&
    (!childSessionId || childSessionId === existing.childSessionId) &&
    (!parentToolCallId || parentToolCallId === existing.parentToolCallId) &&
    (payload.background !== true || existing.backgrounded === true)
  ) {
    return resumedBackgroundWork ? [resumedBackgroundWork] : [];
  }
  if (existing) {
    const row: SubagentRow = {
      ...existing,
      status: "running",
      summaryText:
        stringPayload(payload, "description") ??
        stringPayload(payload, "prompt") ??
        existing.summaryText,
      // resume 事件携带的是 SendMessage call id，但 parentToolCallId 是 row 的创建锚点；
      // 已存在的锚点不能作为生命周期字段被覆盖，否则 UI 无法再关联原 Agent 行。
      ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(payload.background === true ? { backgrounded: true as const } : {}),
      ...(payload.background === true ? { workId: agentId } : {}),
      startedAt: ms(event),
    };
    delete row.endedAt;
    return [{ op: "row.upserted", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
  }
  const row: SubagentRow = {
    ...rowBase(host, event, turnIdOf(host, event), agentId),
    kind: "subagent",
    ...(stringPayload(payload, "parentToolCallId")
      ? { parentToolCallId: stringPayload(payload, "parentToolCallId") }
      : {}),
    subagentType: stringPayload(payload, "agentType") ?? "subagent",
    status: "running",
    summaryText:
      stringPayload(payload, "description") ??
      stringPayload(payload, "summaryText") ??
      stringPayload(payload, "prompt") ??
      "",
    ...(stringPayload(payload, "childSessionId")
      ? { childSessionId: stringPayload(payload, "childSessionId") }
      : {}),
    ...(payload.background === true ? { backgrounded: true as const } : {}),
    ...(payload.background === true ? { workId: agentId } : {}),
    startedAt: ms(event),
  };
  host.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: "row.appended", row }, ...(resumedBackgroundWork ? [resumedBackgroundWork] : [])];
}

function resumedSubagentBackgroundWorkDelta(
  host: ResumedSubagentBackgroundWorkDeltaHost,
  event: SessionEvent,
  payload: Record<string, unknown>,
  agentId: string,
  childSessionId: string | undefined,
): ConversationDelta | undefined {
  if (payload.background !== true || payload.resumed !== true || !childSessionId) {
    return undefined;
  }

  // SendMessage resume 直接进入 subagent port，不经过 Agent tool executor，
  // 因而不会产生 tracker 的 BackgroundTaskStarted。SubagentSpawned 已是单一启动事实，
  // 这里在同一次 V4 transaction 内补齐可取消 work，避免再引入第二个可失败事件。
  const previous = host.snapshot.backgroundWorks;
  const lifecycleId = stringPayload(payload, "lifecycleId");
  if (lifecycleId) {
    host.backgroundLifecycleByWorkId.set(agentId, lifecycleId);
    if (host.consumedBackgroundLifecycles.has(lifecycleId)) return undefined;
  }
  const existing = previous.find((work) => work.workId === agentId);
  const title =
    stringPayload(payload, "description") ??
    stringPayload(payload, "prompt") ??
    existing?.title ??
    agentId;
  if (
    existing?.status === "running" &&
    existing.kind === "subagent" &&
    existing.title === title &&
    existing.childSessionId === childSessionId &&
    existing.cancellable === true
  ) {
    return undefined;
  }
  const next: BackgroundWorkSummary = {
    workId: agentId,
    kind: "subagent",
    title,
    status: "running",
    startedAt: ms(event),
    cancellable: true,
    anchorRowId: existing?.anchorRowId ?? null,
    childSessionId,
  };
  const backgroundWorks = existing
    ? previous.map((work) => (work.workId === agentId ? next : work))
    : [...previous, next];
  return { op: "state.updated", patch: { backgroundWorks } };
}

export function onSubagentMessage(
  host: SubagentMessageHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const row = findSubagentRow(host, subagentAgentId(payload, event));
  const append =
    stringPayload(payload, "summaryText") ??
    stringPayload(payload, "text") ??
    stringPayload(payload, "message");
  if (!row || !append) return [];
  return [{ op: "row.delta", rowId: row.rowId, path: "summaryText", append }];
}

export function onSubagentStopped(
  host: SubagentStoppedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as Record<string, unknown>;
  const agentId = subagentAgentId(payload, event);
  const existing = findSubagentLifecycleRow(host, agentId, payload, event);
  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  const status = mapSubagentStatus(stringPayload(payload, "status"));
  const summaryText =
    stringPayload(payload, "summaryText") ??
    stringPayload(payload, "result") ??
    stringPayload(payload, "error") ??
    stringPayload(payload, "description") ??
    existing?.summaryText ??
    "";
  const row: SubagentRow = existing
    ? {
        ...existing,
        status,
        summaryText,
        endedAt: ms(event),
        // resumed child 的终态同样属于原 Agent row，只在旧 row 缺失锚点时补齐。
        ...(!existing.parentToolCallId && parentToolCallId ? { parentToolCallId } : {}),
        ...(stringPayload(payload, "childSessionId")
          ? { childSessionId: stringPayload(payload, "childSessionId") }
          : {}),
      }
    : {
        ...rowBase(host, event, turnIdOf(host, event), agentId),
        kind: "subagent",
        ...(stringPayload(payload, "parentToolCallId")
          ? {
              parentToolCallId: stringPayload(payload, "parentToolCallId"),
            }
          : {}),
        subagentType: stringPayload(payload, "agentType") ?? "subagent",
        status,
        summaryText,
        ...(stringPayload(payload, "childSessionId")
          ? { childSessionId: stringPayload(payload, "childSessionId") }
          : {}),
        ...(payload.background === true ? { backgrounded: true as const } : {}),
        ...(payload.background === true ? { workId: agentId } : {}),
        endedAt: ms(event),
      };
  host.subagentRowIdByAgentId.set(agentId, row.rowId);
  return [{ op: existing ? "row.upserted" : "row.appended", row }];
}

function findSubagentLifecycleRow(
  host: FindSubagentLifecycleRowHost,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = findSubagentRow(host, agentId);
  if (exact) return exact;

  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = turnIdOf(host, event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return host.snapshot.rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

function subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string {
  return (
    stringPayload(payload, "agentId") ??
    stringPayload(payload, "childSessionId") ??
    stringPayload(payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapSubagentStatus(status: string | undefined): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}
