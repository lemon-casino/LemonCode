import type { CommandPayloadMap } from "@lcode/shared/lcode-protocol-v4";
import type { V4SessionRecordView } from "../types.js";

export class V4InputAdmissionRejectedError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "V4InputAdmissionRejectedError";
  }
}

/** Validate frozen capsule references before held-queue mutation or startNow preemption. */
export async function prepareSendTextContextRefs(
  record: V4SessionRecordView,
  references: CommandPayloadMap["sendText"]["context_refs"],
) {
  if (!references) return {};
  const sharedContextRefs = references.filter(
    (reference) => reference.kind === "shared_context_import",
  );
  const contextCapsuleRefs = references.filter((reference) => reference.kind === "context_capsule");
  if (
    contextCapsuleRefs.length &&
    !(await record.app.runtime.validateContextCapsuleReferences(contextCapsuleRefs))
  )
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "Context capsule is unavailable, stale or belongs to another target session.",
    );
  return { sharedContextRefs, contextCapsuleRefs };
}
