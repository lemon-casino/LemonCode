import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";

export function resolvedPlaceholderAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  errorCode: string,
  options: {
    filename?: string;
    mime?: string;
    sizeBytes?: number;
    source?: FilePartSource;
  } = {},
): ResolvedTurnAttachment {
  const mime =
    options.mime ??
    (attachment.type === "image"
      ? "image/*"
      : attachment.type === "pdf"
        ? "application/pdf"
        : "text/plain");
  const safeOriginalRef = safeAttachmentOriginalRef(attachment);
  return {
    contentBlock: { type: "text", text: `[Attached ${mime}: ${placeholder}]` },
    filename: options.filename,
    metadata: {
      errorCode,
      originalUrl: safeOriginalRef,
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: attachment.path ? "local_ref" : "metadata_only",
    },
    mime,
    source: options.source,
    // 无效 media data URL 虽已降级为占位文本，过去仍会通过 file part 的 url
    // 把 base64 正文落入 session。PDF 不得把 data URL 写入 part.data；可恢复的 artifact
    // URI 仍保留，便于后续诊断和按既定授权路径重试。
    url:
      attachment.type === "video" || attachment.type === "pdf"
        ? attachment.content?.startsWith("lcode-artifact://")
          ? attachment.content
          : (attachment.path ??
            (attachment.type === "pdf" ? "inline:pdf" : (safeOriginalRef ?? "")))
        : (attachment.path ?? attachment.content ?? ""),
  };
}
