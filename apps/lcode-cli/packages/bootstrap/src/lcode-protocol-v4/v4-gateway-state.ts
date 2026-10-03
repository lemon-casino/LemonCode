import { LocalTtftRecorder } from "./local-ttft.js";
import { localTtftNow, localTtftFactsSchema } from "@lcode/shared/lcode-protocol-v4";
import type { SessionEvent } from "@lcode/contracts";
import type { CommandEnvelope, ConversationRowTarget } from "@lcode/shared/lcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@lcode/shared/lcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { ConversationRowTargetAction } from "./product-projection.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { type V4GatewayHost, type ConversationV4GatewayOptions } from "./v4-gateway-contract.js";

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`attachmentRead`）与 dwf 用户面产物的字节
 * （`workflowRunArtifactRead`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
export interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

export interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

export interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export interface V4GatewayState {
  readonly host: V4GatewayHost;
  readonly publishers: Map<string, ConversationTopicPublisher>;
  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  readonly indexPublishers: SessionsIndexPublisherRegistry;
  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  readonly configPublishers: Map<string, WorkspaceConfigPublisher>;
  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  readonly hydratedSessions: Set<string>;
  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  readonly hydrationInFlight: Map<string, Promise<ConversationTopicPublisher>>;
  /** cold activation 到 hydration 的 READY 水位；只阻塞本次恢复期间的 command/query。 */
  readonly readyFlights: Map<string, Promise<ConversationTopicPublisher>>;
  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  readonly hydrationBuffers: Map<string, HydrationBuffer>;
  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  readonly rawSequenceStates: Map<string, RawSequenceState>;
  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  readonly projectionEventCommitWaiters: Map<string, Map<string, Set<ProjectionEventCommitWaiter>>>;
  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  readonly detachedLiveSessions: Set<string>;
  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  readonly detachedChildParent: Map<string, string>;
  readonly detachedChildrenByParent: Map<string, Set<string>>;
  readonly detachedTerminalAt: Map<string, number>;
  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  readonly coldResume: ColdSessionResumeCoordinator;
  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  readonly flushStates: Map<string, FlushState>;
  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  readonly controlReservations: WeakSet<object>;
  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  readonly pausedConnections: Set<string>;
  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  readonly projectionFaultedSessions: Set<string>;
  readonly inbox: CommandInbox;
  readonly attachmentUploads: AttachmentUploadRegistry;
  readonly binaryReadCache: Map<string, BinaryReadCacheEntry>;
  binaryReadCacheBytes: number;
  readonly localTtft: LocalTtftRecorder;
  readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  readonly now: () => number;
  readonly createLogEpoch: (sessionId: string) => string;
  readonly telemetryNormalizer: ConversationTelemetryFactNormalizer;
  readonly cuaPermissionNormalizer: CuaPermissionObservationNormalizer;
  readonly telemetryEventIds: Set<string>;
  disposed: boolean;
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
      return type;
    default:
      return null;
  }
}

export function createGatewayState(
  host: V4GatewayHost,
  options: ConversationV4GatewayOptions,
): V4GatewayState {
  const now = options.now ?? Date.now;
  const state: V4GatewayState = {
    host,
    publishers: new Map<string, ConversationTopicPublisher>(),
    indexPublishers: new SessionsIndexPublisherRegistry(),
    configPublishers: new Map<string, WorkspaceConfigPublisher>(),
    hydratedSessions: new Set<string>(),
    hydrationInFlight: new Map<string, Promise<ConversationTopicPublisher>>(),
    readyFlights: new Map<string, Promise<ConversationTopicPublisher>>(),
    hydrationBuffers: new Map<string, HydrationBuffer>(),
    rawSequenceStates: new Map<string, RawSequenceState>(),
    projectionEventCommitWaiters: new Map<string, Map<string, Set<ProjectionEventCommitWaiter>>>(),
    detachedLiveSessions: new Set<string>(),
    detachedChildParent: new Map<string, string>(),
    detachedChildrenByParent: new Map<string, Set<string>>(),
    detachedTerminalAt: new Map<string, number>(),
    coldResume: new ColdSessionResumeCoordinator(host),
    flushStates: new Map<string, FlushState>(),
    controlReservations: new WeakSet<object>(),
    pausedConnections: new Set<string>(),
    projectionFaultedSessions: new Set<string>(),
    inbox: new CommandInbox({
      getRevision: (sessionId) => {
        if (!state.host.sessionExists(sessionId)) return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return state.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => state.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = state.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => state.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => state.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => state.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => state.host.lookupDiscardedCommand?.(key) ?? null,
      now,
    }),
    attachmentUploads: new AttachmentUploadRegistry({
      now,
      putDraftAttachment: async (draftId, input) => {
        if (!state.host.putDraftAttachment) throw new Error("fault.attachment.putUnsupported");
        return state.host.putDraftAttachment(draftId, input);
      },
      putSessionAttachment: async (sessionId, input) => {
        if (!state.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return state.host.putSessionAttachment(sessionId, input);
      },
    }),
    binaryReadCache: new Map<string, BinaryReadCacheEntry>(),
    binaryReadCacheBytes: 0,
    localTtft: new LocalTtftRecorder(
      localTtftNow,
      () => {
        state.host.onError?.(
          "v4.localTtft.completedCapacity",
          new Error("TTFT completed record capacity exceeded"),
        );
      },
      (facts) => {
        const parsed = localTtftFactsSchema.safeParse(facts);
        if (parsed.success) state.host.emitLocalTtftFacts?.(parsed.data);
      },
    ),
    attachmentPruneTimer: setInterval(
      () => state.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    ),
    now,
    createLogEpoch: options.createLogEpoch ?? defaultLogEpoch,
    telemetryNormalizer: new ConversationTelemetryFactNormalizer(),
    cuaPermissionNormalizer: new CuaPermissionObservationNormalizer(),
    telemetryEventIds: new Set<string>(),
    disposed: false,
  };
  (state.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  return state;
}
