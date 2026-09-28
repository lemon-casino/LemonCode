import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@lcode/shared/lcode-protocol-v4";
import type { MessageId, TurnId } from "@lcode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

async function applyFileRewind(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["applyFileRewind"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "applyFileRewind",
  );
  if (!resolution?.ok) {
    throw new V4RowTranslationError("applyFileRewind", payload.target.rowId);
  }
  const targetMessageIds = (resolution.messageIds ?? []) as MessageId[];
  const targetTurnId = resolution.row.turnId as TurnId;
  const result = await record.app.runtime.applyWorkspaceFileRewind({
    targetMessageIds,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
  return {
    type: "applyFileRewind",
    applied: result.applied,
    preview: result.preview,
    response: result.response,
  };
}

export const fileRewindHandlers = { applyFileRewind };
