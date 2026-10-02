import type { FileSystemErrorCode } from "@lcode/contracts";
import { isFileSystemPortError } from "@lcode/contracts";
import { extractMarkdownArtifactImageRefs } from "@lcode/shared";
import type { AttachmentRef } from "@lcode/shared/lcode-protocol-v4";
import {
  LCODE_ATTACHMENT_FAULT_CODES,
  LCodeAttachmentFaultError,
  readLCodeAttachmentFaultCode,
} from "@lcode/shared/lcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`lcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
export function toShareStatFault(error: unknown): unknown {
  if (readLCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new LCodeAttachmentFaultError(LCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}

export function resolveReadableMediaAttachment(
  publisher: ConversationTopicPublisher,
  sessionId: string,
  ref: string,
  target?: { rowId: number; entityId: string },
  attachmentIndex?: number,
): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
  const isPreviewable = (attachment: AttachmentRef) => {
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return mime.startsWith("image/") || mime.startsWith("video/") || mime === "application/pdf";
  };
  const matchesRef = (attachment: AttachmentRef) =>
    attachment.ref === ref || attachment.previewRef === ref;
  if (target && attachmentIndex !== undefined) {
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
    if (row?.kind !== "userInput") return null;
    const attachment = row.attachments?.[attachmentIndex];
    if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
      return null;
    }
    // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
    // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
    const messageId = publisher.getMessageIdForRow(row.rowId);
    return {
      attachment,
      attachmentIndex,
      ...(messageId ? { messageId } : {}),
    };
  }

  // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
  // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
  for (const row of publisher.getSnapshot().rows.window) {
    if (row.kind === "userInput") {
      for (const attachment of row.attachments ?? []) {
        if (!isPreviewable(attachment)) continue;
        if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
      }
    }
    if (
      row.kind === "assistantText" &&
      artifactRefBelongsToSession(ref, sessionId) &&
      extractMarkdownArtifactImageRefs(row.text).includes(ref)
    ) {
      // assistant Markdown 可以引用工具产出的 session artifact，
      // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
      // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
      // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
      // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
      // 读取另一个 session 的 artifact。
      return {
        attachment: {
          ref,
          fileName: "assistant-image",
          mime: "image/*",
          bytes: 0,
        },
      };
    }
  }
  return null;
}
