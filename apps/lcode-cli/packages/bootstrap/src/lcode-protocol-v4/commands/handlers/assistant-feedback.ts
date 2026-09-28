import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@lcode/shared/lcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

async function setAssistantFeedback(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAssistantFeedback"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "setAssistantFeedback",
  );
  if (!resolution?.ok || !resolution.messageId || resolution.row.kind !== "assistantText") {
    throw new V4RowTranslationError("setAssistantFeedback", payload.target.rowId);
  }
  if (!host.setAssistantFeedback) {
    throw new Error("fault.command.assistantFeedbackUnsupported");
  }
  await host.setAssistantFeedback(record.app.sessionId, {
    entityId: payload.target.entityId,
    messageId: resolution.messageId,
    feedback: payload.feedback,
  });
  return undefined;
}

export const assistantFeedbackHandlers = { setAssistantFeedback };
