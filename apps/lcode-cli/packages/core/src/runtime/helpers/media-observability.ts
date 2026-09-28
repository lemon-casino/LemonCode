import { traceContextToLogContext } from "../deps.js";
import type {
  Logger,
  ModelInputMessage,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import type { MediaBudgetProjection } from "./media-budget.js";
import type { ResolvedTurnAttachment } from "../types.js";

const TURN_ATTACHMENTS_RESOLVED_EVENT = "turn.attachments.resolved";
const MODEL_REQUEST_MEDIA_SUMMARY_EVENT = "model.request.media_summary";
const MEDIA_BLOCK_PREVIEW_LIMIT = 12;

type ContentBlockType = ModelMessageContentBlock["type"];

type ContentBlockCounts = Partial<Record<ContentBlockType, number>>;

type MediaBlockSummary = {
  blockIndex: number;
  blockType: "file" | "image" | "video";
  dataUrlBytes: number;
  mediaType: string;
  messageIndex: number;
  placeholder?: string;
  role: ModelInputMessage["role"];
  sourceKind?: string;
};

export function logResolvedTurnAttachments(
  logger: Logger | undefined,
  traceContext: TraceContext,
  attachments: readonly ResolvedTurnAttachment[],
): void {
  if (attachments.length === 0) return;

  const summaries = attachments.map((attachment, index) =>
    summarizeResolvedTurnAttachment(attachment, index),
  );

  logger?.debug("Turn attachments resolved", {
    ...traceContextToLogContext(traceContext),
    attachmentCount: attachments.length,
    attachmentContentBlockCounts: countBy(summaries, "contentBlockType"),
    attachments: summaries,
    event: TURN_ATTACHMENTS_RESOLVED_EVENT,
    fileAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "file")
      .length,
    imageAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "image")
      .length,
    module: "core.runtime",
    resourceAttachmentCount: summaries.filter(
      (summary) => summary.contentBlockType === "resource_link",
    ).length,
    status: "completed",
    textFallbackAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "text")
      .length,
    videoAttachmentCount: summaries.filter((summary) => summary.contentBlockType === "video")
      .length,
  });
}

export function logModelRequestMediaSummary(
  logger: Logger | undefined,
  traceContext: TraceContext,
  input: {
    incomingMessages: readonly ModelInputMessage[];
    mediaProjection: MediaBudgetProjection;
    providerMessages: readonly ModelInputMessage[];
  },
): void {
  const incomingBlocks = collectMediaBlockSummaries(input.incomingMessages);
  const providerBlocks = collectMediaBlockSummaries(input.providerMessages);
  if (incomingBlocks.length === 0 && providerBlocks.length === 0) return;

  logger?.debug("Model request media summary", {
    ...traceContextToLogContext(traceContext),
    event: MODEL_REQUEST_MEDIA_SUMMARY_EVENT,
    incomingMediaBlockCount: incomingBlocks.length,
    incomingMediaBlocks: incomingBlocks.slice(0, MEDIA_BLOCK_PREVIEW_LIMIT),
    incomingMediaBlocksTruncated: incomingBlocks.length > MEDIA_BLOCK_PREVIEW_LIMIT,
    module: "core.runtime",
    omittedMediaCount: input.mediaProjection.omittedMediaCount,
    projectedMediaBytes: input.mediaProjection.projectedMediaBytes,
    providerMediaBlockCount: providerBlocks.length,
    providerMediaBlocks: providerBlocks.slice(0, MEDIA_BLOCK_PREVIEW_LIMIT),
    providerMediaBlocksTruncated: providerBlocks.length > MEDIA_BLOCK_PREVIEW_LIMIT,
    retainedMediaCount: input.mediaProjection.retainedMediaCount,
    status: "completed",
    totalMediaBytes: input.mediaProjection.totalMediaBytes,
  });
}

function summarizeResolvedTurnAttachment(attachment: ResolvedTurnAttachment, index: number) {
  const block = attachment.contentBlock;
  const blockSource = "source" in block ? block.source : undefined;
  const metadata = attachment.metadata;

  return {
    contentBlockType: block.type,
    dataUrlBytes: contentBlockDataUrlBytes(block),
    errorCode: metadata.errorCode,
    filename: attachment.filename,
    hasArtifact: typeof metadata.artifactUri === "string",
    index,
    mediaType: contentBlockMediaType(block),
    mime: attachment.mime,
    payloadBytes: contentBlockPayloadBytes(block),
    placeholder: blockSource?.placeholder ?? attachment.source?.text.value,
    recoverability: metadata.recoverability,
    sizeBytes: metadata.sizeBytes,
    sourceKind: blockSource?.kind ?? attachment.source?.type,
    storageKind: metadata.storageKind,
    urlKind: classifyAttachmentUrl(attachment.url),
  };
}

function collectMediaBlockSummaries(
  messages: readonly ModelInputMessage[],
): MediaBlockSummary[] {
  const summaries: MediaBlockSummary[] = [];

  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;

    message.content.forEach((block, blockIndex) => {
      if (block.type !== "image" && block.type !== "file" && block.type !== "video") return;
      const dataUrlBytes = contentBlockDataUrlBytes(block);
      if (dataUrlBytes === 0) return;
      summaries.push({
        blockIndex,
        blockType: block.type,
        dataUrlBytes,
        mediaType: contentBlockMediaType(block) ?? "unknown",
        messageIndex,
        placeholder: block.source?.placeholder,
        role: message.role,
        sourceKind: block.source?.kind,
      });
    });
  });

  return summaries;
}

function contentBlockMediaType(block: ModelMessageContentBlock): string | undefined {
  if (block.type === "image" || block.type === "file" || block.type === "video") {
    return block.mediaType;
  }
  return undefined;
}

function contentBlockPayloadBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return base64PayloadBytes(block.dataUrl);
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return base64PayloadBytes(block.dataUrl);
  }
  return 0;
}

function contentBlockDataUrlBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  return 0;
}

function base64PayloadBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return 0;
  return Buffer.byteLength(dataUrl.slice(commaIndex + 1), "utf8");
}

function classifyAttachmentUrl(url: string): "artifact" | "data-url" | "empty" | "reference" {
  if (url.length === 0) return "empty";
  if (url.startsWith("lcode-artifact://")) return "artifact";
  if (url.startsWith("data:")) return "data-url";
  return "reference";
}

function countBy<T extends Record<K, PropertyKey>, K extends keyof T>(
  values: readonly T[],
  key: K,
): ContentBlockCounts {
  const counts: ContentBlockCounts = {};
  for (const value of values) {
    const countKey = value[key] as ContentBlockType;
    counts[countKey] = (counts[countKey] ?? 0) + 1;
  }
  return counts;
}
