import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@lcode/shared/lcode-protocol-v4";
import type { V4CommandCoreHost } from "../types.js";
import { requireRecord } from "../record-access.js";

async function forkSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.forkSession) throw new Error("Sidebar fork capability is unavailable");
  const payload = envelope.payload as CommandPayloadMap["forkSession"];
  const result = await host.forkSession(record.app.sessionId, {
    workspaceMode: payload.workspaceMode,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
  });
  return { type: "forkSession", ...result };
}
export const sidebarForkHandlers = { forkSession };
