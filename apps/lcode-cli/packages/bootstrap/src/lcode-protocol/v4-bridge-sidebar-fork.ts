import type { V4CommandCoreHost } from "../lcode-protocol-v4/commands/types.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { createV4QueryHost } from "./v4-bridge-query-host.js";

export function createSidebarForkHost(
  context: LCodeProtocolAgentServerContext,
  fork: NonNullable<V4CommandCoreHost["forkStableConversation"]>,
): Pick<V4CommandCoreHost, "forkSession"> {
  return {
    forkSession: async (sessionId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) throw new Error("Conversation gateway unavailable");
      const queries = createV4QueryHost(context);
      let beforeRowId: number | undefined;
      for (;;) {
        const page = await gateway.rowsRange({
          sessionId,
          limit: 100,
          beforeRowId,
          clientMode: "web-remote-replayable",
        });
        const row = [...page.rows]
          .reverse()
          .find((row) => row.kind === "assistantText" && row.actions?.canFork === true);
        if (row) {
          const resolved = await queries.resolveStableForkTarget!(sessionId, row.rowId);
          if (!resolved.ok) throw new Error(resolved.reasonCode);
          const result = await fork(sessionId, {
            ...options,
            target: resolved.target,
            goalBoundary: resolved.goalBoundary,
            commandResultType: "forkSession",
          });
          const record = context.sessions.get(result.forkedSessionId);
          const stored =
            !result.workspacePath && !record
              ? await context.deps.sessionStore?.getSession(
                  result.forkedSessionId as import("@lcode/contracts").SessionId,
                )
              : null;
          const workspacePath =
            result.workspacePath ??
            record?.workspace.workspacePath ??
            stored?.path ??
            stored?.directory;
          if (!workspacePath) throw new Error("Fork execution workspace is unavailable");
          return {
            sessionId: result.forkedSessionId,
            workspacePath,
            workspaceIdentity:
              result.workspaceIdentity ??
              record?.workspace.workspaceIdentity ??
              stored?.workspaceID,
          };
        }
        if (!page.hasMore || !page.rows.length) throw new Error("guard.forkTargetNotStable");
        const next = page.rows[0]!.rowId;
        if (beforeRowId !== undefined && next >= beforeRowId)
          throw new Error("Stable fork pagination did not advance");
        beforeRowId = next;
      }
    },
  };
}
