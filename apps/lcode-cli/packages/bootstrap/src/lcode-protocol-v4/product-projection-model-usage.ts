// 模型完成的本会话用量、文件摘要与 Continue 资格；保留 usage 扩展字段。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  type SessionEvent,
  type ModelCompletePayload,
  type ModelUsage,
  getModelUsageContextTokens,
} from "@lcode/contracts";
import type { ConversationDelta } from "@lcode/shared/lcode-protocol-v4";
import { acceptsActiveModelEvent, setApiRetry } from "./product-projection-model-recovery.js";
import { turnIdOf, findRow } from "./product-projection-rows.js";

type ModelCompleteHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "outputContinuationTextRowId"
  | "turnHeaderRowIdByTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
  | "contextWindowState"
>;

export function onModelComplete(host: ModelCompleteHost, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as ModelCompletePayload;
  const retryClearDeltas = acceptsActiveModelEvent(host, event) ? setApiRetry(host, null) : [];
  // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
  const isMainTurn =
    payload.querySource !== undefined
      ? payload.querySource === "main_turn"
      : payload.stopReason !== "tool_internal";
  if (isMainTurn) host.outputContinuationTextRowId = null;
  if (
    isMainTurn &&
    payload.stopReason?.trim().toLowerCase() === "length" &&
    payload.toolCallCount === 0
  ) {
    const lastVisibleRow = host.snapshot.rows.window.at(-1);
    if (
      lastVisibleRow?.kind === "assistantText" &&
      lastVisibleRow.turnId === turnIdOf(host, event) &&
      lastVisibleRow.state === "complete"
    ) {
      host.outputContinuationTextRowId = lastVisibleRow.rowId;
    }
  }
  // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
  // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
  const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
  const deltas: ConversationDelta[] = [];
  if (supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0) {
    const turnId = turnIdOf(host, event);
    const headerRowId = host.turnHeaderRowIdByTurnId.get(turnId);
    const headerRow = headerRowId !== undefined ? findRow(host, headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            additions: payload.fileChanges.additions,
            deletions: payload.fileChanges.deletions,
            files: payload.fileChanges.files,
            state: "active",
          },
        },
      });
    }
  }
  // Bug 原因：子运行时使用 subagent/workflow_child 而非 main_turn，旧门禁将其
  // 所有完成用量丢弃。只给本会话事件记账，不把内部调用的窗口水位写回父会话。
  const isChildTurn =
    (payload.querySource === "subagent" || payload.querySource === "workflow_child") &&
    String(event.sessionId) === host.snapshot.sessionId;
  if (!isMainTurn && !isChildTurn) return [...deltas, ...retryClearDeltas];
  const usage = payload.usage as ModelUsage;
  const usedTokens = isMainTurn ? (getModelUsageContextTokens(usage) ?? 0) : 0;
  if (isMainTurn) host.contextWindowState.usedTokens = usedTokens;
  const maxTokens = payload.contextWindow ?? host.contextWindowState.maxTokens;
  const cumulative = host.snapshot.usage.cumulative;
  deltas.push({
    op: "state.updated",
    patch: {
      usage: {
        // usage 是键级替换；保留网络完成事实派生的请求均速，不让 ModelComplete 丢弃它。
        ...host.snapshot.usage,
        // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
        // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
        contextWindow: !isMainTurn
          ? host.snapshot.usage.contextWindow
          : maxTokens === null
            ? null
            : {
                usedTokens,
                maxTokens,
                autoCompactThresholdTokens:
                  host.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                  ? { breakdown: payload.contextUsageBreakdown }
                  : {}),
              },
        cumulative: {
          inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
      },
    },
  });
  // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
  deltas.push(...retryClearDeltas);
  return deltas;
}
