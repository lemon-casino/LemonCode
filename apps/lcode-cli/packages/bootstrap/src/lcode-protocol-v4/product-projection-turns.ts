// Turn 收口与 queue/guide 工作区边界，保持原工时计账和状态顺序。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent, TurnCompletePayload, TurnErrorPayload } from "@lcode/contracts";
import type {
  ConversationDelta,
  SessionControl,
  GoalState,
  TurnWorkSegment,
  TurnHeaderRow,
} from "@lcode/shared/lcode-protocol-v4";
import { mapTurnResultToHeaderState, buildTurnHeaderRow } from "./projection-rows.js";
import { closeStreamingRows } from "./product-projection-model-stream.js";
import { closeOpenToolRows } from "./product-projection-tool-lifecycle.js";
import { markStableForkAssistant } from "./product-projection-actions.js";
import { controlPatch } from "./product-projection-session.js";
import { ms, findRow, rowBase, turnIdOf } from "./product-projection-rows.js";

type TurnCompleteHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "outputContinuationTextRowId"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
  | "messageIdByRowId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "productTurnSplitOrdinalByRuntimeTurnId"
  | "currentProductTurnStartedAtMs"
  | "currentTurnId"
  | "currentTurnStartedModelOnly"
>;

type LeaveDraftAfterControlOnlyTurnHost = Pick<ProductProjectionState, "snapshot">;

type TurnErrorHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "streamingTextRowId"
  | "streamingReasoningRowId"
  | "outputContinuationTextRowId"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
  | "currentTurnStartedModelOnly"
>;

type SplitProductTurnHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "entityIdByRowId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "runtimeTurnIdByProductTurnId"
  | "productTurnSplitOrdinalByRuntimeTurnId"
  | "currentProductTurnStartedAtMs"
>;

type ActiveMsForCompletionHost = Pick<
  ProductProjectionState,
  "productTurnSplitOrdinalByRuntimeTurnId" | "currentProductTurnStartedAtMs" | "currentTurnId"
>;

type UpsertTurnHeaderHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
>;

export function onTurnComplete(host: TurnCompleteHost, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnCompletePayload;
  host.outputContinuationTextRowId = null;
  const headerState = mapTurnResultToHeaderState(payload.resultType);
  const header = turnHeaderForEvent(host, event);
  if (header?.executionKind === "controlOnly") {
    // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
    // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
    // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
    const deltas = [
      ...upsertTurnHeader(host, event, headerState, undefined, payload.historyRoundCount),
      ...leaveDraftAfterControlOnlyTurn(
        host,
        payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
      ),
    ];
    host.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    host.currentTurnStartedModelOnly = false;
    return deltas;
  }
  const phase: SessionControl["phase"] =
    payload.resultType === "success"
      ? "completedSuccess"
      : payload.resultType === "cancelled"
        ? "completedInterrupted"
        : "error";
  const streamClose = payload.resultType === "success" ? "complete" : "interrupted";

  // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
  // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
  const goal = host.snapshot.goal;
  const pausedGoal: GoalState | undefined =
    payload.resultType === "cancelled" &&
    (goal?.status === "active" || goal?.status === "verifying")
      ? { ...goal, status: "paused" }
      : undefined;

  // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
  // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
  const heldQueue =
    payload.resultType === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    host.snapshot.queue.items.length > 0 &&
    (host.snapshot.queue.autoDrain || host.snapshot.queue.pauseReason !== "stopped")
      ? {
          ...host.snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;

  const deltas: ConversationDelta[] = [
    ...closeStreamingRows(host, streamClose),
    // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
    // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
    ...closeOpenToolRows(host, event, payload.resultType === "cancelled" ? "cancelled" : "error"),
    ...upsertTurnHeader(
      host,
      event,
      headerState,
      activeMsForCompletion(host, event, payload.duration),
      payload.historyRoundCount,
    ),
    ...(payload.resultType === "success" ? markStableForkAssistant(host, event) : []),
    {
      op: "state.updated",
      patch: controlPatch(
        host,
        {
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
          // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
          apiRetry: null,
        },
        pausedGoal,
        heldQueue,
      ),
    },
  ];
  host.currentTurnId = null;
  // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
  host.currentTurnStartedModelOnly = false;
  return deltas;
}

/**
 * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
 * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
 * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
 * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
 * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
 * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
 * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
 */
function leaveDraftAfterControlOnlyTurn(
  host: LeaveDraftAfterControlOnlyTurnHost,
  phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
): ConversationDelta[] {
  if (host.snapshot.control.phase !== "draft") return [];
  return [
    {
      op: "state.updated",
      patch: controlPatch(host, {
        phase,
        sessionEnded: phase !== "error",
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      }),
    },
  ];
}

export function onTurnError(host: TurnErrorHost, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnErrorPayload;
  host.outputContinuationTextRowId = null;
  if (turnHeaderForEvent(host, event)?.executionKind === "controlOnly") {
    const deltas = [
      ...upsertTurnHeader(host, event, "failed"),
      ...leaveDraftAfterControlOnlyTurn(host, "error"),
    ];
    host.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    host.currentTurnStartedModelOnly = false;
    return deltas;
  }
  // TurnError 结束的是当前 turn，
  // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
  // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
  // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
  const heldQueue =
    host.snapshot.queue.items.length > 0
      ? {
          ...host.snapshot.queue,
          autoDrain: false,
          pauseReason: "error" as const,
        }
      : undefined;
  return [
    ...closeStreamingRows(host, "interrupted"),
    ...closeOpenToolRows(host, event, "error"),
    ...upsertTurnHeader(host, event, "failed"),
    {
      op: "state.updated",
      patch: controlPatch(
        host,
        {
          phase: "error",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
          lastError: {
            code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
            message: payload.error.message,
            recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
            at: ms(event),
            // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
            source: payload.error.attribution?.source ?? "runtime",
            traceId: String(event.traceId),
            ...(payload.error.detail ? { detail: payload.error.detail } : {}),
            ...(payload.error.underlyingErrorMessage
              ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
              : {}),
            ...(payload.error.underlyingErrorDetail
              ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
              : {}),
            ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
          },
          // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
          apiRetry: null,
        },
        undefined,
        heldQueue,
      ),
    },
  ];
}

/**
 * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
 * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
 * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
 */
export function splitProductTurn(
  host: SplitProductTurnHost,
  event: SessionEvent,
  runtimeTurnId: string,
  promotedUserMessageId?: string,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const previousProductTurnId =
    host.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  const headerRowId = host.turnHeaderRowIdByTurnId.get(previousProductTurnId);
  const headerRow = headerRowId !== undefined ? findRow(host, headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const endedAt = ms(event);
    deltas.push({
      op: "row.upserted",
      row: {
        ...headerRow,
        state: "completedSuccess",
        endedAt,
        activeMs: Math.max(
          0,
          endedAt - (host.currentProductTurnStartedAtMs ?? headerRow.startedAt),
        ),
        ...(headerRow.workSegments
          ? {
              workSegments: completeWorkSegments(headerRow.workSegments, endedAt),
            }
          : {}),
      },
    });
  }
  const ordinal = (host.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
  host.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
  // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
  // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
  // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
  // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
  const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
  host.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
  host.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
  host.currentProductTurnStartedAtMs = ms(event);
  const header = buildTurnHeaderRow(rowBase(host, event, productTurnId, productTurnId), {
    turnNumber: 0,
    input: "",
  });
  host.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });
  return deltas;
}

// 工时按边界拆分：drain 切过轮的 runtimeTurn，最后一段 productTurn 的工时
// = 最后一次边界到完成，不再用整段 runtime duration（否则两段加和超真实时长）。
function activeMsForCompletion(
  host: ActiveMsForCompletionHost,
  event: SessionEvent,
  runtimeDuration?: number,
): number | undefined {
  const runtimeTurnId = String(event.turnId ?? host.currentTurnId ?? "turn-unknown");
  // 稳定 user messageId 映射并不代表发生过 queue drain 切段；只有 split ordinal
  // 存在时才按边界时间计算最后一段工时。否则 cold 合成事件的展示时间戳跨度很小，
  // 会错误覆盖 transcript 已计算好的整轮 duration。
  if (!host.productTurnSplitOrdinalByRuntimeTurnId.has(runtimeTurnId)) return runtimeDuration;
  if (host.currentProductTurnStartedAtMs === null) return runtimeDuration;
  return Math.max(0, ms(event) - host.currentProductTurnStartedAtMs);
}

function upsertTurnHeader(
  host: UpsertTurnHeaderHost,
  event: SessionEvent,
  state: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
): ConversationDelta[] {
  const row = turnHeaderForEvent(host, event);
  if (!row) return [];
  const endedAt = ms(event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(row.workSegments
          ? {
              workSegments: completeWorkSegments(row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function openGuidedWorkSegment(
  host: UpsertTurnHeaderHost,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = turnHeaderForEvent(host, event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = ms(event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...completeWorkSegments(existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

function completeWorkSegments(
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}

function turnHeaderForEvent(
  host: UpsertTurnHeaderHost,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = host.turnHeaderRowIdByTurnId.get(turnIdOf(host, event));
  if (rowId === undefined) return undefined;
  const row = findRow(host, rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}

// 旧事件没有 retryable 字段；保持历史 UI 的可重试语义，但新事件必须尊重显式 false。
const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;
