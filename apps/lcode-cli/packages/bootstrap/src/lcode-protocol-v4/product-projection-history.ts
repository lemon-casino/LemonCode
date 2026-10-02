// 已提交 rewind、compact coverage 与 fork marker 的历史边界。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import type { SessionEvent, CompactLifecyclePayload, SessionForkedPayload } from "@lcode/contracts";
import type {
  ConversationDelta,
  TimelineMarkerPayload,
  TimelineMarkerRow,
} from "@lcode/shared/lcode-protocol-v4";
import { rowIdForMessageId, findRow, rowBase, turnIdOf, ms } from "./product-projection-rows.js";
import { mapCompactMarkerStatus, mapCompactMarkerOrigin } from "./projection-rows.js";
import { controlPatch } from "./product-projection-session.js";

type RewindTriggeredHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "hookRowIdByInvocationId"
  | "rewoundHookInvocationIds"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "turnHeaderRowIdByTurnId"
>;

type CompactLifecycleHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "entityIdByRowId"
  | "editTargetByEntityId"
  | "stableCompactCoverageBoundaryRowId"
  | "compactMarkerRowIdByOperationId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
  | "contextWindowState"
>;

type SessionForkedHost = Pick<
  ProductProjectionState,
  "snapshot" | "nextRowId" | "entityIdByRowId" | "productTurnIdByRuntimeTurnId" | "currentTurnId"
>;

/**
 * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
 * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
 * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
 * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
 * 由 transcript 合成 hydration 兜底重建。
 * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
 */
export function onRewindTriggered(
  host: RewindTriggeredHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    targetMessageId?: string;
    scope?: string;
    branchCutAfterMessageId?: string;
    branchGeneration?: number;
    createdMessageId?: string;
    reason?: string;
  };
  if (payload.scope === "workspace" && payload.reason === "file_summary_rewind") {
    const targetMessageId = payload.targetMessageId;
    if (!targetMessageId) return [];
    const targetRowId = rowIdForMessageId(host, targetMessageId);
    if (targetRowId === null) return [];
    const targetRow = findRow(host, targetRowId);
    if (!targetRow) return [];
    const headerRowId = host.turnHeaderRowIdByTurnId.get(targetRow.turnId);
    const headerRow = headerRowId !== undefined ? findRow(host, headerRowId) : undefined;
    if (headerRow?.kind !== "turnHeader" || !headerRow.fileChanges) return [];
    return [
      {
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            ...headerRow.fileChanges,
            state: "reverted",
          },
        },
      },
    ];
  }
  // 新语义只消费带 branchGeneration/cut 的已提交 conversation rewind；createdMessageId
  // 仅兼容旧 transcript。失败/冲突不发事件，因此不会制造 UI 假截断。
  const applied =
    (payload.branchGeneration !== undefined && payload.branchCutAfterMessageId !== undefined) ||
    payload.createdMessageId !== undefined;
  if ((payload.scope !== "conversation" && payload.scope !== "both") || !applied) return [];
  const targetMessageId = payload.targetMessageId;
  if (!targetMessageId) return [];
  const targetRowId = rowIdForMessageId(host, targetMessageId);
  if (targetRowId === null) return [];
  const targetRow = findRow(host, targetRowId);
  if (!targetRow) return [];
  // 从该行所属 turn 的首行起移除（整段 turn 被 rewind/edit/retry 替换）。
  const turnHeaderRowId = host.turnHeaderRowIdByTurnId.get(targetRow.turnId) ?? targetRowId;
  const fromRowId = Math.min(turnHeaderRowId, targetRowId);
  // 清理被移除行的 messageId/tool 索引，避免悬挂映射。
  for (const [rowId] of host.messageIdByRowId) {
    if (rowId >= fromRowId) host.messageIdByRowId.delete(rowId);
  }
  for (const [messageId, rowId] of host.outputContinuationRowIdByMessageId) {
    if (rowId >= fromRowId) host.outputContinuationRowIdByMessageId.delete(messageId);
  }
  for (const [rowId, entityId] of host.entityIdByRowId) {
    if (rowId >= fromRowId) {
      host.entityIdByRowId.delete(rowId);
      host.editTargetByEntityId.delete(entityId);
    }
  }
  for (const [hookInvocationId, rowId] of host.hookRowIdByInvocationId) {
    if (rowId >= fromRowId) {
      host.rewoundHookInvocationIds.add(hookInvocationId);
      host.hookRowIdByInvocationId.delete(hookInvocationId);
    }
  }
  return [{ op: "row.removed", fromRowId }];
}

// ── compact marker（compact 命令效果）──
// 同一 operationId 全生命周期占同一 marker row：running → success/failed/noop/cancelled。
// 归属：marker 落在事件到达时的行尾，客户端零归属逻辑。

export function onCompactLifecycle(
  host: CompactLifecycleHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as CompactLifecyclePayload & {
    anchorMessageId?: string;
    tailStartMessageId?: string;
  };
  const existingRowId = host.compactMarkerRowIdByOperationId.get(payload.operationId);
  const existingRow = existingRowId !== undefined ? findRow(host, existingRowId) : undefined;
  const prev =
    existingRow?.kind === "timelineMarker" && existingRow.marker.type === "compact"
      ? existingRow.marker
      : undefined;

  const status = mapCompactMarkerStatus(payload.status);
  if (status === "success") {
    const coverageMessageId = payload.tailStartMessageId ?? payload.anchorMessageId;
    const coverageRowId = coverageMessageId ? rowIdForMessageId(host, coverageMessageId) : null;
    if (coverageRowId !== null) {
      host.stableCompactCoverageBoundaryRowId = Math.max(
        host.stableCompactCoverageBoundaryRowId ?? 0,
        coverageRowId,
      );
      for (const [rowId, entityId] of host.entityIdByRowId) {
        if (rowId > host.stableCompactCoverageBoundaryRowId) continue;
        const target = host.editTargetByEntityId.get(entityId);
        if (target && !target.coveredByStableCompact) {
          host.editTargetByEntityId.set(entityId, {
            ...target,
            coveredByStableCompact: true,
          });
        }
      }
    }
  }
  const tokensAfter =
    payload.truePostCompactTokenCount ?? payload.postCompactTokenCount ?? prev?.tokensAfter;
  const marker: TimelineMarkerPayload = {
    type: "compact",
    origin: prev?.origin ?? mapCompactMarkerOrigin(payload.trigger),
    status,
    // 终态事件才带 token 计数；upsert 时保留已知值（retry 不清零）。
    ...(payload.preCompactTokenCount !== undefined || prev?.tokensBefore !== undefined
      ? { tokensBefore: payload.preCompactTokenCount ?? prev?.tokensBefore }
      : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    // summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位。
    ...(payload.summaryMessageId !== undefined || prev?.summaryRef
      ? {
          summaryRef:
            payload.summaryMessageId !== undefined
              ? String(payload.summaryMessageId)
              : prev?.summaryRef,
        }
      : {}),
  };

  const deltas: ConversationDelta[] = [];
  if (existingRow?.kind === "timelineMarker") {
    deltas.push({
      op: "row.upserted",
      row: {
        ...existingRow,
        marker,
        ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
      },
    });
  } else {
    const row: TimelineMarkerRow = {
      ...rowBase(host, event, turnIdOf(host, event), String(payload.operationId)),
      kind: "timelineMarker",
      lane: "assistantWork",
      marker,
      ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
    };
    host.compactMarkerRowIdByOperationId.set(payload.operationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }

  // compacting 进出 activeWorks（guard 同源派生：compactOperationLock /
  // compactingAcceptsFutureInput 由此驱动，与 formal-proof evaluateCompacting 对齐）。
  const otherWorks = host.snapshot.control.activeWorks.filter((work) => work.kind !== "compact");
  if (status === "running") {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(host, {
        activeWorks: [...otherWorks, { kind: "compact", startedAt: ms(event) }],
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: otherWorks.length > 0 ? "mixed" : "compact",
      }),
    });
  } else {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(host, {
        activeWorks: otherWorks,
        ...(otherWorks.length === 0
          ? {
              canStop: false,
              stopState: "idle" as const,
              stopTargetKind: "unknown" as const,
            }
          : {}),
      }),
    });
  }

  // compact 成功 → context 水位立即回落（usage.contextWindow 更新）。
  if (status === "success" && tokensAfter !== undefined) {
    host.contextWindowState.usedTokens = tokensAfter;
    const maxTokens =
      host.snapshot.usage.contextWindow?.maxTokens ?? host.contextWindowState.maxTokens;
    deltas.push({
      op: "state.updated",
      patch: {
        usage: {
          ...host.snapshot.usage,
          contextWindow:
            maxTokens === null
              ? null
              : {
                  usedTokens: tokensAfter,
                  maxTokens,
                  autoCompactThresholdTokens:
                    host.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                },
        },
      },
    });
  }
  return deltas;
}

// ── fork marker（forkAssistant 命令效果）──

export function onSessionForked(host: SessionForkedHost, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as SessionForkedPayload;
  const isParent = String(payload.originalSessionId) === host.snapshot.sessionId;
  if (isParent) {
    // 父时间线不显示 forkCreated——fork 关系只在 sessions
    // 树/列表体现。旧实现以 nextRowId-1 近似锚点产 row，且 UI 渲染为 null
    // （隐形行污染 turn 分组）；child 首部 forkNotice 保留不变。
    return [];
  }
  // child 首部 forkNotice（forkTimelineIsBoundary）：事件 payload 不携带
  // parent 侧 rowId，先以 0 占位；transcript 锚点 → rowId 映射随传输外壳补齐。
  const row: TimelineMarkerRow = {
    ...rowBase(
      host,
      event,
      turnIdOf(host, event),
      `fork:${String(payload.originalSessionId)}:${String(payload.targetMessageId ?? "unknown")}`,
    ),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker: {
      type: "forkNotice",
      parentSessionId: String(payload.originalSessionId),
      parentRowId: 0,
    },
  };
  return [{ op: "row.appended", row }];
}
