import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@lcode/shared/lcode-protocol-v4";
import type { V4CommandCoreHost } from "../types.js";
import { requireRecord } from "../record-access.js";

async function resolveWorktreeConflicts(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.resolveWorktreeConflicts)
    throw new Error("Worktree conflict repair is unavailable on this Host");
  const { operationId, waitForRequestId } =
    envelope.payload as CommandPayloadMap["resolveWorktreeConflicts"];
  const result = await host.resolveWorktreeConflicts(record.app.sessionId, {
    operationId,
    requestId: envelope.commandId,
    waitForRequestId,
  });
  return { type: "resolveWorktreeConflicts", operationId, sessionId: result.sessionId };
}
export const worktreeRepairHandlers = { resolveWorktreeConflicts };
