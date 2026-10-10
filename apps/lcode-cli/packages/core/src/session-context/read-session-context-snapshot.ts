import { createHash } from "node:crypto";
import {
  stableContextMessages,
  contextCapsuleSourcePayload,
  type MessageWithParts,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import { activeSessionMessagesForSession } from "./active-session-messages.js";
import { canReadSessionContextFromWorkspace } from "./workspace-session-scope.js";

export interface ScopedSessionContextSnapshot {
  messages: MessageWithParts[];
  session: SessionInfo;
  sourceVersion?: string;
  boundaryMessageId?: string;
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
  stableCompleted?: boolean;
}): Promise<ScopedSessionContextSnapshot | undefined> {
  const initialSession = await input.sessionStore.getSession(input.sessionId);
  if (!isScopedTarget(initialSession, input.sessionId, input.workspace)) return undefined;

  const messages = await input.sessionStore.messages({ sessionID: input.sessionId });
  const refreshedSession = await input.sessionStore.getSession(input.sessionId);
  // messages 与 session metadata 分步读取；投影前重读并复核 scope，
  // 以最新 revert 边界 fail closed，避免并发 rewind 后丢弃分支重新暴露。
  if (!isScopedTarget(refreshedSession, input.sessionId, input.workspace)) return undefined;

  if (!input.stableCompleted) return { messages, session: refreshedSession };
  const stableMessages = stableContextMessages(
    activeSessionMessagesForSession(messages, refreshedSession),
  );
  return {
    messages: stableMessages,
    session: refreshedSession,
    sourceVersion: createHash("sha256")
      .update(contextCapsuleSourcePayload(refreshedSession, stableMessages))
      .digest("hex"),
    boundaryMessageId: stableMessages.at(-1)?.info.id,
  };
}

export async function scopedContextSnapshotStillCurrent(input: {
  snapshot: ScopedSessionContextSnapshot;
  sessionStore: SessionStorePort;
  workspace: { workspaceIdentity?: string; workspaceRoot: string };
}): Promise<boolean> {
  const latest = await loadScopedSessionContextSnapshot({
    sessionId: input.snapshot.session.id,
    sessionStore: input.sessionStore,
    workspace: input.workspace,
    stableCompleted: true,
  });
  if (!latest) return false;
  const prefix = latest.messages.slice(0, input.snapshot.messages.length);
  // 新完成尾部可以追加；只有冻结 prefix 仍为同一 active branch 且内容未变才交付旧版本摘要。
  return (
    createHash("sha256")
      .update(contextCapsuleSourcePayload(latest.session, prefix))
      .digest("hex") === input.snapshot.sourceVersion
  );
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
