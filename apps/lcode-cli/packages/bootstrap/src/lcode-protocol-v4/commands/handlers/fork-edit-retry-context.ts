import { readContextCapsuleRefs } from "@lcode/shared/lcode-protocol-v4";
import type { ConversationEditTarget } from "../../product-projection.js";
import type { V4SessionRecordView } from "../types.js";
import { prepareSendTextContextRefs, V4InputAdmissionRejectedError } from "./send-text-context.js";

/** Validate historical admission refs before stopping the current execution or cutting history. */
export async function prepareHistoricalCapsuleRefs(
  record: V4SessionRecordView,
  target: ConversationEditTarget,
  editedText?: string,
): Promise<ConversationEditTarget["intent"]["contextCapsuleRefs"]> {
  const refs = resolveHistoricalCapsuleRefs(target, editedText);
  if (!refs.length) return undefined;
  return (await prepareSendTextContextRefs(record, refs)).contextCapsuleRefs;
}

/** Admission and handler execution share the same historical reference selection. */
export function resolveHistoricalCapsuleRefs(target: ConversationEditTarget, editedText?: string) {
  const original = target.intent.contextCapsuleRefs ?? [];
  let refs = original;
  if (editedText !== undefined) {
    try {
      refs = readContextCapsuleRefs(editedText);
    } catch {
      throw new V4InputAdmissionRejectedError(
        "proto.invalidPayload",
        "A message can reference at most 4 saved summaries.",
      );
    }
    // 冷恢复只传已接纳的 typed refs；编辑不能从文本旁路新增权限，也不能隐式复活被删除的背景。
    const admitted = new Set(original.map((ref) => ref.capsule_id));
    if (refs.some((ref) => !admitted.has(ref.capsule_id))) {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "Editing cannot add saved-summary references; send a new input instead.",
      );
    }
  }
  return refs;
}
