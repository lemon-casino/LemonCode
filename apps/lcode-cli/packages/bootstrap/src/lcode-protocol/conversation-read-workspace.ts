import type { SessionId, SessionInfo } from "@lcode/contracts";
import { lcodeWorkspaceRefSchema, type LCodeWorkspaceRef } from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { buildWorkspaceRef, originWorkspaceRef } from "./workspace.js";
import { WORKTREE_BINDING_ENTRY } from "./worktree-execution.js";

const workspaceKey = (workspace: LCodeWorkspaceRef) =>
  workspace.workspaceIdentity?.trim() || workspace.workspacePath;

export class ConversationReadWorkspaceError extends Error {
  constructor(
    readonly reasonCode:
      | "fault.history.sessionNotFound"
      | "fault.history.workspaceMismatch"
      | "fault.history.remoteSessionMismatch",
    sessionId?: string,
  ) {
    super(sessionId ? `${reasonCode}: ${sessionId}` : reasonCode);
    this.name = "ConversationReadWorkspaceError";
  }
}

/** 沿用执行绑定的 schema 与 origin 语义，不能把详情入口路径当作文件执行 cwd。 */
export async function resolveConversationReadWorkspace(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  stored: SessionInfo | null | undefined,
  requested?: LCodeWorkspaceRef,
): Promise<LCodeWorkspaceRef> {
  const direct = context.sessions.get(sessionId)?.workspace;
  const entries =
    !direct && stored
      ? await context.deps.sessionStore?.sessionEntries?.({
          sessionID: sessionId as SessionId,
          type: WORKTREE_BINDING_ENTRY,
        })
      : undefined;
  const binding = lcodeWorkspaceRefSchema.safeParse(
    entries?.filter((entry) => entry.type === WORKTREE_BINDING_ENTRY).at(-1)?.data,
  );
  const execution =
    direct ??
    (binding.success
      ? binding.data
      : stored
        ? buildWorkspaceRef({
            workspacePath: stored.path ?? stored.directory,
            workspaceIdentity: stored.workspaceID,
          })
        : undefined);
  if (!execution)
    throw new ConversationReadWorkspaceError("fault.history.sessionNotFound", sessionId);
  if (requested) {
    const key = workspaceKey(requested);
    if (key !== workspaceKey(execution) && key !== workspaceKey(originWorkspaceRef(execution)))
      throw new ConversationReadWorkspaceError("fault.history.workspaceMismatch");
    if (
      execution.remoteSessionId &&
      requested.remoteSessionId &&
      execution.remoteSessionId !== requested.remoteSessionId
    )
      throw new ConversationReadWorkspaceError("fault.history.remoteSessionMismatch");
  }
  return {
    ...execution,
    ...(requested?.remoteSessionId ? { remoteSessionId: requested.remoteSessionId } : {}),
  };
}
