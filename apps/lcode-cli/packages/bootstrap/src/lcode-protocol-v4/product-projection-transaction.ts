// 唯一事件提交路径：归约 → 派生 actions/revision → apply；冷恢复沿用同一字段。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  createMutableConversationSnapshotAccumulator,
  type ConversationDelta,
  applyConversationDeltasMutable,
  applyConversationDeltas,
} from "@lcode/shared/lcode-protocol-v4";
import { type SessionEvent, SessionEventType } from "@lcode/contracts";
import { materializeCommandRowActions } from "./product-projection-actions.js";
import { stringPayload } from "./product-projection-subagents.js";
import { onAssistantFeedbackUpdated } from "./product-projection-model-stream.js";
import { normalizeConversationEvent } from "./event-normalizer.js";
import {
  openAssistantSegments,
  updateRowIndexAfterImmutableApply,
} from "./product-projection-rows.js";
import { reduce } from "./product-projection-events.js";
import {
  shouldMaterializeSubagentProjection,
  materializeSubagentProjection,
} from "./product-projection-subagent-manifest.js";
import { clearSettledOutputPreviews } from "./product-projection-bash-progress.js";
import { updateToolIndexesAfterDeltas } from "./product-projection-tool-lifecycle.js";
import { deltaBumpsRevision } from "./projection-state.js";

type BeginHydrationReplayHost = Pick<
  ProductProjectionState,
  "snapshot" | "rowIndexById" | "hydrationAccumulator"
>;

type CompleteHydrationReplayHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "hydrationAccumulator"
  | "messageIdByRowId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "currentEditableEntityId"
  | "turnHeaderRowIdByTurnId"
>;

type AttachRevisionHost = Pick<ProductProjectionState, "snapshot">;

/**
 * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
 * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
 */
export function beginHydrationReplay(host: BeginHydrationReplayHost): void {
  if (host.hydrationAccumulator) throw new Error("hydration replay already active");
  host.hydrationAccumulator = createMutableConversationSnapshotAccumulator(host.snapshot);
  host.snapshot = host.hydrationAccumulator.snapshot;
  host.rowIndexById = host.hydrationAccumulator.rowIndexById;
}

export function applyHydrationEvent(
  host: ProductProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!host.hydrationAccumulator) throw new Error("hydration replay is not active");
  return applyEventInternal(host, event, false);
}

/**
 * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
 * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
 */
export function completeHydrationReplay(host: CompleteHydrationReplayHost): ConversationDelta[] {
  if (!host.hydrationAccumulator) throw new Error("hydration replay is not active");
  const deltas = materializeCommandRowActions(host, []);
  applyConversationDeltasMutable(host.hydrationAccumulator, deltas);
  host.hydrationAccumulator = null;
  return deltas;
}

export function applyEventInternal(
  host: ProductProjectionState,
  event: SessionEvent,
  materializeActions: boolean,
): ConversationDelta[] {
  if (event.type === SessionEventType.SubagentSpawned) {
    const childSessionId = stringPayload(
      event.payload as Record<string, unknown>,
      "childSessionId",
    );
    // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
    // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
    if (childSessionId) host.invalidSubagentChildSessionIds.delete(childSessionId);
  }
  const runtimeTurnId = String(event.turnId ?? host.currentTurnId ?? "turn-unknown");
  const productTurnId =
    event.type === SessionEventType.TurnStarted
      ? undefined
      : (host.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
  const reduced =
    event.type === SessionEventType.AssistantFeedbackUpdated
      ? onAssistantFeedbackUpdated(host, event)
      : (() => {
          const fact = normalizeConversationEvent(event, {
            productTurnId,
            openAssistantSegments: openAssistantSegments(host),
          });
          host.normalizationDiagnostics.push(...fact.diagnostics);
          return reduce(host, fact);
        })();
  const subagentDeltas = shouldMaterializeSubagentProjection(host, reduced)
    ? materializeSubagentProjection(host, reduced)
    : [];
  const reducedWithSubagents = [...reduced, ...subagentDeltas];
  // row、命令 target 与 actions 必须属于同一个 materialization transaction。
  // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
  // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
  const deltas = materializeActions
    ? [...reducedWithSubagents, ...materializeCommandRowActions(host, reducedWithSubagents)]
    : reducedWithSubagents;
  const finalDeltas = attachRevision(host, clearSettledOutputPreviews(deltas));
  if (host.hydrationAccumulator) {
    applyConversationDeltasMutable(host.hydrationAccumulator, finalDeltas);
    host.snapshot.seq = event.sequenceNumber;
  } else {
    const previousRowsLength = host.snapshot.rows.window.length;
    host.snapshot = {
      ...applyConversationDeltas(host.snapshot, finalDeltas),
      seq: event.sequenceNumber,
    };
    updateRowIndexAfterImmutableApply(host, previousRowsLength, finalDeltas);
  }
  updateToolIndexesAfterDeltas(host, finalDeltas);
  return finalDeltas;
}

// revision 递进：本事件含任一结构性 delta → revision +1，
// 且携带规则要求 deltas 中必含 state.updated.revision。
function attachRevision(
  host: AttachRevisionHost,
  deltas: ConversationDelta[],
): ConversationDelta[] {
  if (!deltas.some(deltaBumpsRevision)) return deltas;
  const revision = host.snapshot.revision + 1;
  const last = deltas[deltas.length - 1];
  if (last?.op === "state.updated") {
    return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
  }
  return [...deltas, { op: "state.updated", patch: { revision } }];
}

export function cloneProjectionState(
  host: ProductProjectionState,
  clone: ProductProjectionState,
): void {
  clone.snapshot = host.snapshot;
  clone.rowIndexById = new Map(host.rowIndexById);
  clone.hydrationAccumulator = null;
  clone.nextRowId = host.nextRowId;
  clone.streamingTextRowId = host.streamingTextRowId;
  clone.streamingReasoningRowId = host.streamingReasoningRowId;
  clone.outputContinuationTextRowId = host.outputContinuationTextRowId;
  clone.toolRowIdByCallId = new Map(host.toolRowIdByCallId);
  // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
  clone.latestListAppsSnapshot = new Map(host.latestListAppsSnapshot);
  clone.openForegroundToolCallIds = new Set(host.openForegroundToolCallIds);
  clone.fileToolInputPreviewByCallId = new Map(
    [...host.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [toolCallId, { ...state }]),
  );
  clone.subagentRowIdByAgentId = new Map(host.subagentRowIdByAgentId);
  clone.backgroundLifecycleByWorkId = new Map(host.backgroundLifecycleByWorkId);
  clone.consumedBackgroundLifecycles = new Set(host.consumedBackgroundLifecycles);
  clone.hookRowIdByInvocationId = new Map(host.hookRowIdByInvocationId);
  clone.pendingSessionHookInvocations = new Map(
    [...host.pendingSessionHookInvocations].map(([invocationId, pending]) => [
      invocationId,
      {
        firstEvent: pending.firstEvent,
        content: {
          ...pending.content,
          executions: pending.content.executions.map((execution) => ({ ...execution })),
        },
      },
    ]),
  );
  clone.rewoundHookInvocationIds = new Set(host.rewoundHookInvocationIds);
  clone.invalidSubagentChildSessionIds = new Set(host.invalidSubagentChildSessionIds);
  clone.messageIdByRowId = new Map(host.messageIdByRowId);
  clone.outputContinuationRowIdByMessageId = new Map(host.outputContinuationRowIdByMessageId);
  clone.entityIdByRowId = new Map(host.entityIdByRowId);
  clone.editTargetByEntityId = new Map(host.editTargetByEntityId);
  clone.currentEditableEntityId = host.currentEditableEntityId;
  clone.stableCompactCoverageBoundaryRowId = host.stableCompactCoverageBoundaryRowId;
  clone.turnHeaderRowIdByTurnId = new Map(host.turnHeaderRowIdByTurnId);
  clone.compactMarkerRowIdByOperationId = new Map(host.compactMarkerRowIdByOperationId);
  clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(host.goalVerifyMarkerRowIdByLifecycleKey);
  clone.productTurnIdByRuntimeTurnId = new Map(host.productTurnIdByRuntimeTurnId);
  clone.runtimeTurnIdByProductTurnId = new Map(host.runtimeTurnIdByProductTurnId);
  clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
    host.productTurnSplitOrdinalByRuntimeTurnId,
  );
  clone.currentProductTurnStartedAtMs = host.currentProductTurnStartedAtMs;
  clone.deliveryByPendingInputId = new Map(host.deliveryByPendingInputId);
  clone.currentTurnId = host.currentTurnId;
  clone.currentTurnStartedModelOnly = host.currentTurnStartedModelOnly;
  clone.contextWindowState = { ...host.contextWindowState };
  clone.lastTurnModel = { ...host.lastTurnModel };
  clone.configModelTouchedByEvent = host.configModelTouchedByEvent;
  clone.configThoughtLevelsTouchedByEvent = host.configThoughtLevelsTouchedByEvent;
  clone.configModeTouchedByEvent = host.configModeTouchedByEvent;
  clone.executionFailoverRevision = host.executionFailoverRevision;
  clone.executionFailoverEpochStartSequence = host.executionFailoverEpochStartSequence;
  clone.droppedContentStreamEventCount = host.droppedContentStreamEventCount;
  clone.normalizationDiagnostics = [...host.normalizationDiagnostics];
}

export function adoptProjectionState(
  host: ProductProjectionState,
  candidate: ProductProjectionState,
): void {
  host.snapshot = candidate.snapshot;
  host.rowIndexById = candidate.rowIndexById;
  host.hydrationAccumulator = null;
  host.nextRowId = candidate.nextRowId;
  host.streamingTextRowId = candidate.streamingTextRowId;
  host.streamingReasoningRowId = candidate.streamingReasoningRowId;
  host.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
  host.toolRowIdByCallId = candidate.toolRowIdByCallId;
  host.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
  host.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
  host.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
  host.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
  host.backgroundLifecycleByWorkId = candidate.backgroundLifecycleByWorkId;
  host.consumedBackgroundLifecycles = candidate.consumedBackgroundLifecycles;
  host.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
  host.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
  host.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
  host.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
  host.messageIdByRowId = candidate.messageIdByRowId;
  host.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
  host.entityIdByRowId = candidate.entityIdByRowId;
  host.editTargetByEntityId = candidate.editTargetByEntityId;
  host.currentEditableEntityId = candidate.currentEditableEntityId;
  host.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
  host.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
  host.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
  host.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
  host.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
  host.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
  host.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
  host.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
  host.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
  host.currentTurnId = candidate.currentTurnId;
  host.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
  host.contextWindowState = candidate.contextWindowState;
  host.lastTurnModel = candidate.lastTurnModel;
  host.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
  host.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
  host.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
  host.executionFailoverRevision = candidate.executionFailoverRevision;
  host.executionFailoverEpochStartSequence = candidate.executionFailoverEpochStartSequence;
  host.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
  host.normalizationDiagnostics = candidate.normalizationDiagnostics;
}
