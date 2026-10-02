import type {
  CommandEnvelope,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  QueueItem,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
} from "@lcode/shared/lcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  filterConversationRowsForProfile,
} from "@lcode/shared/lcode-protocol-v4";
import { conversationJsonByteLength } from "./conversation-topic-workflow-bytes.js";
import {
  type StableForkCandidateResolution,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
} from "./product-projection.js";
import { type ConversationTopicState } from "./conversation-topic-state.js";

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPlanMarkdown(row: ToolCallRow): boolean {
  if (isRecord(row.input)) {
    const plan = row.input.plan;
    if (typeof plan === "string" && plan.trim().length > 0) return true;
  }
  if (!row.inputText.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return isRecord(parsed) && typeof parsed.plan === "string" && parsed.plan.trim().length > 0;
  } catch {
    return false;
  }
}

export function getSnapshot(
  state: Pick<ConversationTopicState, "projection">,
): ConversationSnapshot {
  return state.projection.getSnapshot();
}

/** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */
export function getWireSnapshotLogicalBytes(
  state: Pick<ConversationTopicState, "logEpoch" | "projection" | "topic">,
): number {
  return measureWireSnapshotBytes(state, getWireSnapshot(state));
}

export function resolveStableForkCandidate(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): StableForkCandidateResolution {
  return state.projection.resolveStableForkCandidate(rowId);
}

/** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */
export function seedConfig(
  state: Pick<
    ConversationTopicState,
    "logEpoch" | "projection" | "topic" | "wireSnapshotBytesUpperBound"
  >,
  seed: SessionConfigSeed,
): void {
  state.projection.seedConfig(seed);
  state.wireSnapshotBytesUpperBound = measureWireSnapshotBytes(state, getWireSnapshot(state));
}

/** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */
export function seedSharedContextImport(
  state: Pick<
    ConversationTopicState,
    "logEpoch" | "projection" | "topic" | "wireSnapshotBytesUpperBound"
  >,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  state.projection.seedSharedContextImport(source);
  state.wireSnapshotBytesUpperBound = measureWireSnapshotBytes(state, getWireSnapshot(state));
}

/** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */
export function seedUsage(
  state: Pick<
    ConversationTopicState,
    "logEpoch" | "projection" | "topic" | "wireSnapshotBytesUpperBound"
  >,
  seed: SessionUsageSeed,
): void {
  state.projection.seedUsage(seed);
  state.wireSnapshotBytesUpperBound = measureWireSnapshotBytes(state, getWireSnapshot(state));
}

/** cold hydration 的 store-verified subagent manifest，不产 delta。 */
export function seedSubagents(
  state: Pick<
    ConversationTopicState,
    "logEpoch" | "projection" | "topic" | "wireSnapshotBytesUpperBound"
  >,
  seed: SessionSubagentsSeed,
): void {
  state.projection.seedSubagents(seed);
  state.wireSnapshotBytesUpperBound = measureWireSnapshotBytes(state, getWireSnapshot(state));
}

/**
 * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
 * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
 * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
 * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
 */
export function getWireSnapshot(
  state: Pick<ConversationTopicState, "projection">,
  snapshot = state.projection.getSnapshot(),
): ConversationSnapshot {
  return getWireSnapshotForProfile(state, DELIVERY_PROFILES.continuous, snapshot);
}

export function getWireSnapshotForProfile(
  state: Pick<ConversationTopicState, "projection">,
  profile: DeliveryProfile,
  snapshot = state.projection.getSnapshot(),
): ConversationSnapshot {
  const visibleRows = filterConversationRowsForProfile(snapshot.rows.window, profile);
  const visibleSnapshot: ConversationSnapshot = {
    ...snapshot,
    rows: {
      ...snapshot.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (visibleRows.length <= limit) return visibleSnapshot;
  return {
    ...visibleSnapshot,
    rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-limit) },
  };
}

/**
 * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
 * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
 * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
 */
export function measureInputAdmissionProjectionBytes(
  state: Pick<ConversationTopicState, "logEpoch" | "projection" | "topic">,
  envelope: CommandEnvelope,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
): number | null {
  const raw = envelope.payload as {
    text?: string;
    displayText?: string;
    attachments?: QueueItem["attachments"];
    firstInput?: { text: string; attachments?: QueueItem["attachments"] };
  };
  const input = envelope.type === "createSession" ? raw.firstInput : raw;
  if (
    !input ||
    (envelope.type !== "createSession" &&
      envelope.type !== "sendText" &&
      envelope.type !== "sendGoalCommand" &&
      envelope.type !== "compact")
  ) {
    return null;
  }
  const snapshot = state.projection.getSnapshot();
  const queueItem: QueueItem = {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    text:
      envelope.type === "compact"
        ? "/compact"
        : envelope.type === "sendGoalCommand"
          ? raw.displayText?.trim() || `/goal ${(input.text ?? "").trim()}`
          : (input.text ?? ""),
    attachments: input.attachments ?? [],
    delivery: { requested: "queue", admitted: "queue" },
    order: {
      admissionSeq: admission.admissionSeq,
      queuePosition: snapshot.queue.items.length,
    },
    steer: { state: "notRequested" },
    dispatch: { state: "queued" },
    admittedAt: admission.admittedAt,
  };
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  return measureWireSnapshotBytes(state, getWireSnapshot(state, candidate));
}

export function measureWireSnapshotBytes(
  state: Pick<ConversationTopicState, "logEpoch" | "topic">,
  snapshot: ConversationSnapshot,
): number {
  // subscriptionId/时间/seq 使用本 publisher 可产生的最长常规表示，确保测量不是只算 payload。
  const frame: ConversationTopicFrame = {
    topic: state.topic,
    subscriptionId: `sub-${state.logEpoch}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot },
  };
  return conversationJsonByteLength(frame);
}

/**
 * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
 * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
 * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
 * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
 */
export function getRowsRange(
  state: Pick<ConversationTopicState, "logEpoch" | "projection">,
  params: { beforeRowId?: number; limit: number },
  deliveryProfile: DeliveryProfileName = "replayable",
): V4ConversationRowsRangeResult {
  const snapshot = state.projection.getSnapshot();
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const visibleRows = filterConversationRowsForProfile(
    snapshot.rows.window,
    DELIVERY_PROFILES[deliveryProfile],
  );
  const eligible =
    params.beforeRowId === undefined
      ? visibleRows
      : visibleRows.filter((row) => row.rowId < (params.beforeRowId as number));
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: state.logEpoch,
    hasMore: eligible.length > rows.length,
  };
}

/**
 * 返回当前有效分支里的完整终态计划目录。
 * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
 * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
 */
export function getPlans(
  state: Pick<ConversationTopicState, "logEpoch" | "projection">,
): V4ConversationPlansResult {
  const snapshot = state.projection.getSnapshot();
  const plans = snapshot.rows.window
    .filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.toolName === "ExitPlanMode" &&
        TERMINAL_PLAN_STATUSES.has(row.status) &&
        hasPlanMarkdown(row),
    )
    .toSorted((left, right) => right.rowId - left.rowId);
  return {
    plans,
    atSeq: snapshot.seq,
    atLogEpoch: state.logEpoch,
  };
}

/** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */
export function getMessageIdForRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): string | null {
  return state.projection.getMessageIdForRow(rowId);
}

export function resolveRowActionTarget(
  state: Pick<ConversationTopicState, "projection">,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
): ConversationRowTargetResolution {
  return state.projection.resolveRowActionTarget(target, action);
}

/** rowId → 同一 product turn 内所有 transcript messageId。 */
export function getMessageIdsForTurnRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): string[] {
  return state.projection.getMessageIdsForTurnRow(rowId);
}

/** fork 目标必须是所属轮最后一段 assistantText。 */
export function isLatestAssistantSegmentRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): boolean {
  return state.projection.isLatestAssistantSegmentRow(rowId);
}

/** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
export function isLatestRetryAssistantRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): boolean {
  return state.projection.isLatestRetryAssistantRow(rowId);
}

/** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */
export function isLatestEditableUserRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): boolean {
  return state.projection.isLatestEditableUserRow(rowId);
}

/** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
export function getTurnIdForRow(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): string | null {
  return state.projection.getTurnIdForRow(rowId);
}

/** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */
export function getDroppedContentStreamEventCount(
  state: Pick<ConversationTopicState, "projection">,
): number {
  return state.projection.getDroppedContentStreamEventCount();
}

/** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */
export function getTurnRewindAnchor(
  state: Pick<ConversationTopicState, "projection">,
  rowId: number,
): string | null {
  return state.projection.getTurnRewindAnchor(rowId);
}
