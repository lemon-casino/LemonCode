import type {
  ConversationDelta,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  SubscribeAck,
} from "@lcode/shared/lcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";
import { ProductProjection } from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import { getWireSnapshot, measureWireSnapshotBytes } from "./conversation-topic-queries.js";
import { nonNegativeHardBound } from "./conversation-topic-buffer.js";

export interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

export interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /** flush buffer：push 时已过 profile 过滤，flush 时 coalesce 打帧。 */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** buffer 超限后只保留恢复意图，不继续为慢订阅者积压 delta。 */
  resyncRequired: boolean;
  /** 帧区间记账水位：下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  /** 编码/写入期间保留的稳定 logical frame。 */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** 缺省 replayable（ws 默认；MessagePort 宿主显式传 continuous）。 */
  deliveryProfile?: DeliveryProfileName;
}

export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** initial encode 失败且 ACK 未 admission 时，原子恢复被替换的旧 subscription。 */
  rollback(): boolean;
  /** snapshot 帧或 resume 的续传帧；resume 且无新增时为 null（客户端水位已对齐）。 */
  readonly frame: ConversationTopicFrame | null;
}

export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface ConversationTopicPublisherOptions {
  /** CLI 时钟（frame.sentAt / clockOffset 估计源）。 */
  now?: () => number;
  /** 事件保留窗（条），默认 PROTOCOL_V4_LIMITS.eventRetentionPerSession。 */
  retention?: number;
  /** 每订阅者 coalesce 后 op 上限；主要用于协议配置与边界测试。 */
  subscriberBufferMaxOps?: number;
  /** 每订阅者 logical deltas payload 的 UTF-8 byte 上限。 */
  subscriberBufferMaxBytes?: number;
}

export interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  maxBytes?: number;
}

export type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

export interface ConversationTopicState {
  readonly sessionId: string;
  readonly logEpoch: string;
  readonly topic: string;
  projection: ProductProjection;
  readonly now: () => number;
  readonly retention: number;
  readonly subscriberBufferMaxOps: number;
  readonly subscriberBufferMaxBytes: number;
  /** 有界日志：seq 升序；resume 只在 (floorSeq, currentSeq] 内合法。 */
  readonly log: LogEntry[];
  /** 保留窗下界：base.seq < floorSeq 的恢复请求已无法无损续传 → 只能 snapshot。 */
  floorSeq: number;
  readonly subscriptions: Map<string, Subscription>;
  readonly subscriptionIdByConnection: Map<string, string>;
  nextSubscriptionSerial: number;
  nextLogicalFrameSerial: number;
  /** 当前 snapshot logical frame 的保守上界；流式追加只累计增量，逼近上限才精确序列化。 */
  wireSnapshotBytesUpperBound: number;
}

export function createConversationTopicState(
  sessionId: string,
  logEpoch: string,
  options: ConversationTopicPublisherOptions = {},
): ConversationTopicState {
  const state: ConversationTopicState = {
    sessionId,
    logEpoch,
    topic: `conversation/${sessionId}`,
    projection: new ProductProjection(sessionId, logEpoch),
    now: options.now ?? Date.now,
    retention: options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession,
    subscriberBufferMaxOps: nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    ),
    subscriberBufferMaxBytes: nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    ),
    log: [],
    floorSeq: 0,
    subscriptions: new Map(),
    subscriptionIdByConnection: new Map(),
    nextSubscriptionSerial: 1,
    nextLogicalFrameSerial: 1,
    wireSnapshotBytesUpperBound: 0,
  };
  state.wireSnapshotBytesUpperBound = measureWireSnapshotBytes(state, getWireSnapshot(state));
  return state;
}
