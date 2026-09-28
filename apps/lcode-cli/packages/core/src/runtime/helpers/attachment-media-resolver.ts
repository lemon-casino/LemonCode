import { basename, isFileSystemPortError, resolvePath } from "../deps.js";
import { VIDEO_INPUT_MAX_BYTES } from "@lcode/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";
import { INLINE_MEDIA_ATTACHMENT_MAX_BYTES } from "../types.js";
import type { PreparedImageData, ResolvedTurnAttachment } from "../types.js";
import { persistAttachmentDataUrl } from "./attachment-artifacts.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
import { inferVideoMimeFromPath, parseInlineVideoDataUrl } from "./attachment-video.js";
import { isPdfBytes, parseInlinePdfDataUrl, PDF_INPUT_MAX_BYTES } from "./attachment-pdf.js";
import { resolvedPathReferenceAttachment } from "./attachment-path-reference.js";

interface InlineMediaResolverOptions {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  existingArtifactUri?: string;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
}

interface LocalMediaResolverOptions extends Omit<
  InlineMediaResolverOptions,
  "existingArtifactUri"
> {
  fileSystemPort: FileSystemPort;
  workingDirectory: string;
}

interface LocalMediaContext {
  absolutePath: string;
  attachment: TurnAttachment;
  filename: string;
  index: number;
  mime: string;
  options: LocalMediaResolverOptions;
  source: FilePartSource;
  stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
}

export async function resolveInlineMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions,
): Promise<ResolvedTurnAttachment | undefined> {
  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  if (attachment.type === "image" && attachment.content && parsedMediaType?.startsWith("image/")) {
    let prepared: PreparedImageData | undefined;
    try {
      prepared = await prepareImageDataUrl(attachment.content, parsedMediaType, options);
    } catch {
      return resolvedPlaceholderAttachment(
        attachment,
        placeholder,
        "attachment_image_resize_failed",
      );
    }
    if (!prepared) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_image_invalid");
    }
    const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "image",
        mediaType: prepared.mediaType,
        dataUrl: prepared.dataUrl,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: options.existingArtifactUri ? parsedMediaType : prepared.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      metadata: {
        ...(prepared.metadata ? { image: prepared.metadata } : {}),
        recoverability: resource.metadata.recoverability,
        sizeBytes: Buffer.byteLength(attachment.content, "utf8"),
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: prepared.mediaType,
      url: resource.url,
    };
  }

  if (attachment.type === "pdf" && attachment.content) {
    const pdfData = parseInlinePdfDataUrl(attachment.content);
    if (!pdfData) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: attachment.sizeBytes,
      });
    }
    if (pdfData.sizeBytes === 0 || pdfData.sizeBytes > PDF_INPUT_MAX_BYTES) {
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_pdf_invalid", {
        filename: attachment.filename,
        mime: "application/pdf",
        sizeBytes: pdfData.sizeBytes,
      });
    }
    const resource = await persistAttachmentDataUrl(attachment.content, index, pdfData.mediaType, {
      abortSignal: options.abortSignal,
      artifactStore: options.artifactStore,
      existingArtifactUri: options.existingArtifactUri,
      sessionId: options.sessionId,
      traceContext: options.traceContext,
      turnId: options.turnId,
    });
    return {
      contentBlock: {
        type: "file",
        mediaType: pdfData.mediaType,
        name: attachment.filename,
        dataUrl: attachment.content,
        source: {
          id: `turn-attachment-${index + 1}`,
          kind: "inline",
          mimeType: pdfData.mediaType,
          placeholder,
          ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
        },
      },
      filename: attachment.filename,
      metadata: {
        recoverability: resource.metadata.recoverability,
        sizeBytes: pdfData.sizeBytes,
        storageKind: resource.metadata.storageKind,
        ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
      },
      mime: pdfData.mediaType,
      url: resource.url,
    };
  }

  if (attachment.type !== "video" || !attachment.content) return undefined;

  const videoData = parseInlineVideoDataUrl(attachment.content);
  if (!videoData) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: attachment.mimeType ?? parsedMediaType ?? "video/*",
      sizeBytes: attachment.sizeBytes,
    });
  }
  // 空 payload 曾绕过视频大小校验并被持久化，导致实时与冷恢复消息形态不一致。
  if (videoData.sizeBytes === 0) {
    return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_video_invalid", {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
    });
  }
  if (videoData.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, placeholder, {
      filename: attachment.filename,
      mime: videoData.mediaType,
      sizeBytes: videoData.sizeBytes,
      reason: "video_too_large",
    });
  }
  const resource = await persistAttachmentDataUrl(attachment.content, index, videoData.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    existingArtifactUri: options.existingArtifactUri,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "video",
      mediaType: videoData.mediaType,
      dataUrl: attachment.content,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "inline",
        mimeType: videoData.mediaType,
        placeholder,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    metadata: {
      recoverability: resource.metadata.recoverability,
      sizeBytes: videoData.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: videoData.mediaType,
    url: resource.url,
  };
}

export async function resolveLocalMediaAttachment(
  attachment: TurnAttachment,
  index: number,
  options: LocalMediaResolverOptions,
): Promise<ResolvedTurnAttachment> {
  const attachmentPath = attachment.path!;
  const absolutePath = resolvePath(options.workingDirectory, attachmentPath);
  const filename = basename(absolutePath);
  const mime =
    attachment.type === "image"
      ? inferImageMimeFromPath(absolutePath)
      : attachment.type === "pdf"
        ? "application/pdf"
        : (inferVideoMimeFromPath(absolutePath) ?? attachment.mimeType ?? "video/mp4");
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachmentPath, start: 0, end: attachmentPath.length },
  };
  let stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
  try {
    stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (stat.kind !== "file") {
    return resolvedPlaceholderAttachment(attachment, attachmentPath, "attachment_not_file", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }

  const context: LocalMediaContext = {
    absolutePath,
    attachment,
    filename,
    index,
    mime,
    options,
    source,
    stat,
  };
  if (attachment.type === "image") return resolveLocalImageAttachment(context);
  if (attachment.type === "pdf") return resolveLocalPdfAttachment(context);
  return resolveLocalVideoAttachment(context);
}

async function resolveLocalPdfAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, mime, options, source, stat } = context;
  if (stat.sizeBytes > PDF_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "pdf_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: PDF_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "pdf_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  if (read.bytesRead === 0 || !isPdfBytes(read.content)) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_pdf_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, context.index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "file",
      mediaType: mime,
      name: filename,
      dataUrl,
      source: {
        id: `turn-attachment-${context.index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: read.sizeBytes,
        sha256: read.revision?.hash,
        ...(resource.metadata.artifactUri ? { uri: resource.metadata.artifactUri } : {}),
      },
    },
    filename,
    metadata: {
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime,
    source,
    url: resource.url,
  };
}

async function resolveLocalImageAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > INLINE_MEDIA_ATTACHMENT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "image_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readTextFile"]>>;
  try {
    read = await options.fileSystemPort.readTextFile(
      { path: absolutePath, encoding: "base64", trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch {
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  const dataUrl = `data:${mime};base64,${read.content}`;
  let prepared: PreparedImageData | undefined;
  try {
    prepared = await prepareImageDataUrl(dataUrl, mime, options);
  } catch {
    return resolvedPlaceholderAttachment(
      attachment,
      attachment.path!,
      "attachment_image_resize_failed",
      { filename, mime, sizeBytes: stat.sizeBytes, source },
    );
  }
  if (!prepared) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_image_invalid", {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
    });
  }
  const resource = await persistAttachmentDataUrl(prepared.dataUrl, index, prepared.mediaType, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "image",
      mediaType: prepared.mediaType,
      dataUrl: prepared.dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: prepared.mediaType,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: stat.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      ...(prepared.metadata ? { image: prepared.metadata } : {}),
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: stat.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime: prepared.mediaType,
    source,
    url: resource.url,
  };
}

async function resolveLocalVideoAttachment(
  context: LocalMediaContext,
): Promise<ResolvedTurnAttachment> {
  const { absolutePath, attachment, filename, index, mime, options, source, stat } = context;
  if (stat.sizeBytes > VIDEO_INPUT_MAX_BYTES) {
    return resolvedPathReferenceAttachment(attachment, attachment.path!, {
      filename,
      mime,
      sizeBytes: stat.sizeBytes,
      source,
      reason: "video_too_large",
    });
  }
  let read: Awaited<ReturnType<FileSystemPort["readBinaryFile"]>>;
  try {
    read = await options.fileSystemPort.readBinaryFile(
      { path: absolutePath, maxBytes: VIDEO_INPUT_MAX_BYTES, trace: options.traceContext },
      { signal: options.abortSignal },
    );
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      // 外层 stat 后文件仍可能增长；以读取端的 maxBytes 结果为最终边界。
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        source,
        reason: "video_too_large",
      });
    }
    return localMediaReadFailure(attachment, filename, mime, source);
  }
  // 文件可能在 stat 后被清空，必须以实际读取结果判断是否为有效视频。
  if (read.bytesRead === 0) {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_video_invalid", {
      filename,
      mime,
      sizeBytes: read.sizeBytes,
      source,
    });
  }
  const dataUrl = `data:${mime};base64,${Buffer.from(read.content).toString("base64")}`;
  const resource = await persistAttachmentDataUrl(dataUrl, index, mime, {
    abortSignal: options.abortSignal,
    artifactStore: options.artifactStore,
    sessionId: options.sessionId,
    traceContext: options.traceContext,
    turnId: options.turnId,
  });
  return {
    contentBlock: {
      type: "video",
      mediaType: mime,
      dataUrl,
      source: {
        id: `turn-attachment-${index + 1}`,
        kind: "local_file",
        mimeType: mime,
        path: absolutePath,
        placeholder: attachment.path,
        sizeBytes: read.sizeBytes,
        sha256: read.revision?.hash,
      },
    },
    filename,
    metadata: {
      originalUrl: attachment.path,
      recoverability: resource.metadata.recoverability,
      sha256: read.revision?.hash,
      sizeBytes: read.sizeBytes,
      storageKind: resource.metadata.storageKind,
      ...(resource.metadata.artifactUri ? { artifactUri: resource.metadata.artifactUri } : {}),
    },
    mime,
    source,
    url: resource.url,
  };
}

function localMediaReadFailure(
  attachment: TurnAttachment,
  filename: string,
  mime: string,
  source: FilePartSource,
): ResolvedTurnAttachment {
  return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
    filename,
    mime,
    source,
  });
}
