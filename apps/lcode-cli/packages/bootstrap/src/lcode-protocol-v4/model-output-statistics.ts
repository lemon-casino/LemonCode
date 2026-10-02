import type { ModelNetworkStatusPayload } from "@lcode/contracts";
import type { ConversationDelta, SessionUsageState } from "@lcode/shared/lcode-protocol-v4";

type ModelOutput = SessionUsageState["modelOutput"];
const SESSION_MODEL_QUERY_SOURCES = new Set(["main_turn", "subagent", "workflow_child"]);

function patchOutput(usage: SessionUsageState, modelOutput: ModelOutput): ConversationDelta[] {
  return [{ op: "state.updated", patch: { usage: { ...usage, modelOutput } } }];
}

/** 只消费当前会话/轮次的网络请求事实；调用者负责投影活动态和归属校验。 */
export function projectModelOutputStatus(
  usage: SessionUsageState,
  payload: ModelNetworkStatusPayload,
  turnId: string,
  at: number,
): ConversationDelta[] {
  if (payload.querySource && !SESSION_MODEL_QUERY_SOURCES.has(payload.querySource)) return [];
  if (!payload.requestId || !turnId || !Number.isFinite(at) || at < 0) return [];
  const previous = usage.modelOutput?.turnId === turnId ? usage.modelOutput : null;
  if (payload.type === "model_request_started") {
    if (previous?.activeRequestId === payload.requestId) return [];
    return patchOutput(usage, {
      turnId,
      activeRequestId: payload.requestId,
      lastRequest: previous?.lastRequest ?? null,
    });
  }
  if (payload.type !== "model_request_completed" && payload.type !== "model_request_failed") {
    return [];
  }
  // Bug 原因：新请求已启动时，旧尝试的迟到回包不能清除新请求或覆盖其读数。
  // 中途建投影可能未见 started；仅在尚无请求事实时接受完整的 completed 事实。
  if (previous && previous.activeRequestId !== payload.requestId) return [];
  if (payload.type === "model_request_failed") {
    return previous ? patchOutput(usage, { ...previous, activeRequestId: null }) : [];
  }
  const outputTokens = payload.usage?.outputTokens;
  const durationMs = payload.durationMs;
  const valid =
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens > 0 &&
    Number.isFinite(durationMs) &&
    durationMs > 0;
  return patchOutput(usage, {
    turnId,
    activeRequestId: null,
    // outputTokens 已包含 reasoning 分类；缺失账单不反推、不叠加、不伪装成 0。
    lastRequest: valid
      ? { requestId: payload.requestId, outputTokens, durationMs, completedAt: at }
      : null,
  });
}

export function resetModelOutput(usage: SessionUsageState): ConversationDelta[] {
  return usage.modelOutput ? patchOutput(usage, null) : [];
}

export function clearActiveModelOutput(
  usage: SessionUsageState,
  turnId: string,
): ConversationDelta[] {
  const previous = usage.modelOutput;
  return previous?.turnId === turnId && previous.activeRequestId !== null
    ? patchOutput(usage, { ...previous, activeRequestId: null })
    : [];
}
