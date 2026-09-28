import type { MessageWithParts, SessionId, SessionInfo, SessionStorePort } from "@lcode/contracts";
import { canReadSessionContextFromWorkspace } from "./workspace-session-scope.js";

export interface ScopedSessionContextSnapshot {
  messages: MessageWithParts[];
  session: SessionInfo;
}

/**
 * Load a workspace-scoped transcript and refresh metadata after the message read.
 *
 * SessionStorePort currently has no atomic session+messages snapshot. A conversation rewind can
 * therefore commit between the first metadata lookup and append-only message materialization.
 * The second lookup deliberately prefers omission over pairing fresh rows with a stale branch boundary.
 */
export async function loadScopedSessionContextSnapshot(input: {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  workspace: { workspaceIdentity?: string; workspaceRoot: string };
}): Promise<ScopedSessionContextSnapshot | undefined> {
  const initialSession = await input.sessionStore.getSession(input.sessionId);
  if (!isScopedTarget(initialSession, input.sessionId, input.workspace)) return undefined;

  const messages = await input.sessionStore.messages({ sessionID: input.sessionId });
  const refreshedSession = await input.sessionStore.getSession(input.sessionId);
  // messages 与 session metadata 分步读取；投影前重读并复核 scope，
  // 以最新 revert 边界 fail closed，避免并发 rewind 后丢弃分支重新暴露。
  if (!isScopedTarget(refreshedSession, input.sessionId, input.workspace)) return undefined;

  return { messages, session: refreshedSession };
}

function isScopedTarget(
  session: SessionInfo | null,
  expectedSessionId: SessionId,
  workspace: { workspaceIdentity?: string; workspaceRoot: string },
): session is SessionInfo {
  return (
    session !== null &&
    session.id === expectedSessionId &&
    canReadSessionContextFromWorkspace(session, workspace)
  );
}
