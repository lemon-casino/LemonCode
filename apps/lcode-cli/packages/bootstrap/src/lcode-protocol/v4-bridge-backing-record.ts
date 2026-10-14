import type { SessionId } from "@lcode/contracts";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export async function resolveConversationBackingRecord(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<LCodeProtocolSessionRecord | undefined> {
  let current = sessionId;
  let workspaceKey: string | undefined;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const direct = context.sessions.get(current);
    if (direct) {
      if (
        workspaceKey &&
        direct.workspace &&
        (direct.workspace.workspaceIdentity?.trim() || direct.workspace.workspacePath) !==
          workspaceKey
      )
        throw new Error("fault.history.workspaceMismatch");
      return direct;
    }
    const stored = await context.deps.sessionStore?.getSession(current as SessionId);
    if (!stored?.parentID) return undefined;
    workspaceKey ??= stored.workspaceID?.trim() || stored.path || stored.directory;
    current = String(stored.parentID);
  }
  throw new Error("fault.history.parentCycle");
}
