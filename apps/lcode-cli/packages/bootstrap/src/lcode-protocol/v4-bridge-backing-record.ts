import type { SessionId } from "@lcode/contracts";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export async function resolveConversationBackingRecord(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<LCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // 运行中 subagent 有独立 child event log，但没有独立 bootstrap record。
  // 文件摘要只需要共享 event/artifact store，因此通过持久化 parentID 找到父 record 作为
  // artifact reader，读取事件时仍显式使用 childSessionId；不能为了只读查询 cold resume
  // 第二个 child runtime。
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}
