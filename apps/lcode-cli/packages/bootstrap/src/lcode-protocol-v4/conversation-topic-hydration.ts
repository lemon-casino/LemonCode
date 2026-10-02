import { Buffer } from "node:buffer";
import { type SessionEvent } from "@lcode/contracts";
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";
import { getWireSnapshot, measureWireSnapshotBytes } from "./conversation-topic-queries.js";
import { ingest, projectionLimitForEvent } from "./conversation-topic-ingest.js";
import {
  type ConversationTopicState,
  createConversationTopicState,
} from "./conversation-topic-state.js";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-buffer.js";

/**
 * cold replay 会高频测量临时 delta；TextEncoder 会为每次测量再分配完整 Uint8Array。
 * CLI 已固定运行在 Node，这里对同一 JSON 文本直接计算精确 UTF-8 字节数，不做近似估算。
 */
function coldHydrationJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

// row.actions 的 schema 只有 4 个 true 布尔值和一个短枚举；含 JSON key/父级包装不足
// 128 bytes。批量 checkpoint 之间按 wire tail 的每行完整预留，保证延迟 materialize
// 不会让 payload 上界低估。
const HYDRATION_ACTION_BYTES_PER_WIRE_ROW = 128;

const HYDRATION_EVENT_WIRE_OVERHEAD_BYTES = 64;

// logical snapshot frame 中 sequence number 同时出现在 frame.toSeq 与 snapshot.seq。
const HYDRATION_SEQUENCE_NUMBER_OCCURRENCES = 2;

function hydrationSequenceNumberBytes(sequenceNumber: number): number {
  return String(sequenceNumber).length * HYDRATION_SEQUENCE_NUMBER_OCCURRENCES;
}

/**
 * 在现有 publisher 内重物化 projection，保留 connection-owned subscriptions。
 *
 * gateway 过去 delete publisher 后新建实例，projection 虽恢复了，旧实例
 * 的 subscription registry / ownership / in-flight reservation 却一起丢失。重物化属于
 * 同一 topic authority 的状态替换，只应让既有订阅 resync，不应换 publisher 身份。
 */
export function rehydrate(
  state: Pick<
    ConversationTopicState,
    | "floorSeq"
    | "log"
    | "logEpoch"
    | "now"
    | "projection"
    | "retention"
    | "sessionId"
    | "subscriberBufferMaxBytes"
    | "subscriberBufferMaxOps"
    | "subscriptions"
    | "wireSnapshotBytesUpperBound"
  >,
  events: readonly SessionEvent[],
  options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
): void {
  // 重放不能先清空当前 projection/log/subscription delivery，再逐条 replay：
  // 任一普通 reducer 异常都会把 topic 留在半重放状态。候选 publisher 不承接订阅，
  // 完整 replay（含 logical size 校验）成功后才一次 adopt 权威数据面。
  let candidate = createConversationTopicState(state.sessionId, state.logEpoch, {
    now: state.now,
    retention: state.retention,
    subscriberBufferMaxOps: state.subscriberBufferMaxOps,
    subscriberBufferMaxBytes: state.subscriberBufferMaxBytes,
  });
  const usedBatchHydration = tryBatchHydration(candidate, events);
  if (!usedBatchHydration) {
    // 保守上界超限不代表权威 projection 一定超限；重新从空候选走原逐事件原子
    // admission，保留 16MiB fail-closed 与“拒绝单个 oversize 后继续终态”的旧语义。
    candidate = createConversationTopicState(state.sessionId, state.logEpoch, {
      now: state.now,
      retention: state.retention,
      subscriberBufferMaxOps: state.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: state.subscriberBufferMaxBytes,
    });
    for (const event of events) {
      try {
        ingest(candidate, event);
      } catch (error) {
        if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
        if (!options.onPayloadTooLarge) throw error;
        options.onPayloadTooLarge(error);
      }
    }
  }

  state.projection = candidate.projection;
  if (usedBatchHydration) {
    // 批量重放会把派生 actions 延迟到最终 materialization；若允许客户端
    // 用逐事件旧快照的中间 base 续这份日志，batch 从未持有的旧 canEdit/canRetry 无法被
    // 定点撤销。rehydrate 本来就要求所有现有订阅 resync，因此在当前 seq 建立 snapshot
    // recovery boundary；此后新事件仍从该水位正常 resume，不改变 replayable 恢复语义。
    state.log.splice(0, state.log.length);
    state.floorSeq = candidate.projection.getSnapshot().seq;
  } else {
    // strict fallback 没有延迟 materialization，完整保留原有 retained-log 恢复语义。
    state.log.splice(0, state.log.length, ...candidate.log);
    state.floorSeq = candidate.floorSeq;
  }
  state.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
  for (const subscription of state.subscriptions.values()) {
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = true;
    subscription.sentSeq = 0;
    // adopt 后旧 projection 上预留的帧不可再 commit；失败 replay 从未触碰该 reservation。
    subscription.inFlight = null;
  }
}

/**
 * 冷恢复快路径：只修改尚未发布的 candidate。协议 wire snapshot 固定只含末尾 60 行，
 * 因此 row 更新只累计仍在 tail 的 delta，再给尚未 materialize 的 actions 按行预留
 * 完整 schema 上界；已滑出 tail 的保守增长在触及 payload limit 时通过精确测量消除。
 * 最终只做一次全行 actions 收敛，整体成本随事件/行数线性增长。
 */
export function tryBatchHydration(
  state: Pick<
    ConversationTopicState,
    "logEpoch" | "projection" | "topic" | "wireSnapshotBytesUpperBound"
  >,
  events: readonly SessionEvent[],
): boolean {
  state.projection.beginHydrationReplay();
  let measuredBytes = state.wireSnapshotBytesUpperBound;
  let measuredSequenceNumberBytes = hydrationSequenceNumberBytes(
    state.projection.getSnapshot().seq,
  );
  let encodedGrowthSinceMeasurement = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const deltas = state.projection.applyHydrationEvent(event);
    const finalEvent = index === events.length - 1;
    const projectionLimit = projectionLimitForEvent(event);
    const mustMeasureSnapshot = finalEvent || deltas.some((delta) => delta.op === "row.removed");

    if (finalEvent) state.projection.completeHydrationReplay();
    const snapshot = state.projection.getSnapshot();
    if (!mustMeasureSnapshot && deltas.length > 0) {
      let wireRowIds: Set<number> | undefined;
      const wireDeltas = deltas.filter((delta) => {
        if (delta.op === "state.updated" || delta.op === "row.appended") return true;
        if (delta.op === "row.removed") return false;
        wireRowIds ??= new Set(
          snapshot.rows.window
            .slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows)
            .map((row) => row.rowId),
        );
        const rowId = delta.op === "row.upserted" ? delta.row.rowId : delta.rowId;
        return wireRowIds.has(rowId);
      });
      if (wireDeltas.length > 0) {
        encodedGrowthSinceMeasurement +=
          coldHydrationJsonByteLength({ kind: "deltas", deltas: wireDeltas }) +
          HYDRATION_EVENT_WIRE_OVERHEAD_BYTES;
      }
    }

    const actionBytesUpperBound = finalEvent
      ? 0
      : Math.min(snapshot.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows) *
        HYDRATION_ACTION_BYTES_PER_WIRE_ROW;
    const currentSequenceNumberBytes = hydrationSequenceNumberBytes(snapshot.seq);
    const sequenceNumberGrowth = Math.max(
      0,
      currentSequenceNumberBytes - measuredSequenceNumberBytes,
    );
    let upperBound =
      measuredBytes + encodedGrowthSinceMeasurement + sequenceNumberGrowth + actionBytesUpperBound;
    if (mustMeasureSnapshot || upperBound > projectionLimit) {
      // 保守 delta 累计值一旦超限就直接回退 strict 的话，重复 upsert
      // 即使未增大 snapshot 也会误回退；固定 32-event 重测还会反复序列化 checkpoint。
      measuredBytes = measureWireSnapshotBytes(state, getWireSnapshot(state));
      measuredSequenceNumberBytes = currentSequenceNumberBytes;
      encodedGrowthSinceMeasurement = 0;
      upperBound = measuredBytes + actionBytesUpperBound;
    }
    if (upperBound > projectionLimit) return false;
  }

  if (events.length === 0) {
    state.projection.completeHydrationReplay();
    measuredBytes = measureWireSnapshotBytes(state, getWireSnapshot(state));
  }
  state.wireSnapshotBytesUpperBound = measuredBytes;
  return true;
}
