import type { ModelSelection } from "@lcode/shared";
import type { AttachmentRef, ConversationRowTarget } from "@lcode/shared/lcode-protocol-v4";

export interface EditUserQueryPayloadInput {
  target: ConversationRowTarget;
  newText: string;
  attachments?: readonly AttachmentRef[];
  modelSelection: ModelSelection;
  workspaceMode: "preserve" | "rewind";
}

/** 组装历史编辑的单次提交 payload；模型选择必须来自提交瞬间已校验的 Composer。 */
export function buildEditUserQueryPayload({
  target,
  newText,
  attachments,
  modelSelection,
  workspaceMode,
}: EditUserQueryPayloadInput) {
  return {
    target,
    newText,
    modelSelection,
    workspaceMode,
    ...(attachments ? { attachments: [...attachments] } : {}),
  };
}
