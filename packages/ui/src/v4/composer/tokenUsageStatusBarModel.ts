import type { ConversationSnapshot, SessionUsageState } from "@lcode/shared/lcode-protocol-v4";
import { readSessionTokenTotal, type ChildSessionUsage } from "./sessionTokenStats.js";

/** 草稿即使已有预热快照也没有会话用量；不能用 0 Token 或分页空窗隐藏真实的首轮请求。 */
export function hasStatusBarConversation(
  snapshot: ConversationSnapshot | null | undefined,
  draftMode: boolean,
): boolean {
  return !draftMode && Boolean(snapshot && snapshot.control.phase !== "draft");
}

export function readStatusBarTotals(
  usage: SessionUsageState["cumulative"] | undefined,
  children: ChildSessionUsage | undefined,
  contextUsed = 0,
) {
  const own = readSessionTokenTotal(usage ?? null, contextUsed);
  const childTotal = (children?.inputTokens ?? 0) + (children?.outputTokens ?? 0);
  const knownTotal = (own ?? 0) + childTotal;
  return {
    own,
    children: childTotal,
    total: own === null && childTotal === 0 ? null : knownTotal,
    partial: own === null || (children?.unknownCount ?? 0) > 0,
  };
}

export function readStatusBarRequest(snapshot: ConversationSnapshot | null | undefined) {
  const output = snapshot?.usage.modelOutput;
  const request = output?.lastRequest;
  if (!request || output?.turnId !== snapshot?.rows.window.at(-1)?.turnId) return null;
  return Number.isFinite(request.outputTokens) &&
    request.outputTokens > 0 &&
    Number.isFinite(request.durationMs) &&
    request.durationMs > 0
    ? request
    : null;
}
