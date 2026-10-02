import {
  modelMessageContentToText,
  type FilePart,
  type MessagePart,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ToolArtifactStorePort,
} from "@lcode/contracts";
import {
  getSystemReminderDescriptor,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../system-reminder/source.js";
import {
  buildPromptAttachmentReminderBodies,
  type PromptAttachmentReminderInput,
} from "../system-reminder/prompt-attachment.js";
import {
  isKnownSystemReminderSource,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
  type RuntimeMessageSource,
} from "./message-history.js";
import { runtimeInputMetadata } from "./runtime-input-presentation.js";
import { filePartToContentBlock } from "./file-part-hydration.js";

export async function userEntriesFromParts(
  parts: MessagePart[],
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<RuntimeMessageEntry[]> {
  const attachmentBlocks: ModelMessageContentBlock[] = [];
  // 媒体数据块（image/video）统一后置组，恢复顺序对齐 live 主路径 [text, media]。
  const inlineMediaBlocks: ModelMessageContentBlock[] = [];
  const promptBlocks: ModelMessageContentBlock[] = [];
  const syntheticAttachmentEntries: RuntimeMessageEntry[] = [];
  const promptAttachmentEntries: RuntimeMessageEntry[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      const syntheticAttachment = syntheticSystemReminderAttachmentFromTextPart(part);
      if (syntheticAttachment) {
        syntheticAttachmentEntries.push(
          systemReminderAttachmentEntry(syntheticAttachment.source, syntheticAttachment.content),
        );
        continue;
      }
      promptBlocks.push({ type: "text", text: textPartToProviderText(part) });
      continue;
    }

    if (part.type === "file") {
      const block = await filePartToContentBlock(part, artifactStore);
      // local_ref 是附件恢复历史时的唯一路径句柄，不能因为 metadata_only 过滤。
      if (block.type === "text") {
        const promptAttachmentInput = promptAttachmentReminderInputForFilePart(part, block);
        if (promptAttachmentInput) {
          const reminderBody =
            buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
          promptAttachmentEntries.push(
            systemReminderAttachmentEntry("prompt_attachment", reminderBody),
          );
          continue;
        }
      }
      if (block.type === "image" || block.type === "video") {
        inlineMediaBlocks.push(block);
      } else {
        attachmentBlocks.push(block);
      }
      continue;
    }

    if (part.type === "agent") {
      promptBlocks.push({ type: "text", text: `[Selected agent: ${part.name}]` });
    }
  }

  const content = contentFromUserBlocks(
    [...attachmentBlocks, ...promptBlocks, ...inlineMediaBlocks],
    {
      preserveBlocks: attachmentBlocks.length > 0 || inlineMediaBlocks.length > 0,
    },
  );
  const hasUserContent = modelMessageContentToText(content).trim().length > 0;
  const userMetadata = metadataFromUserParts(parts);
  // 文本附件从原始 file part 恢复为 prompt_attachment 后，空正文的
  // real_user envelope 曾被 trim 判空丢弃，导致 live 与 resume 的 provider history 不一致。
  // 这里只恢复 Agent 内存锚点；bare-empty 和纯 synthetic/meta user 仍不生成空消息。
  const shouldRestoreRealUserEnvelope =
    hasUserContent || (userMetadata.source === "real_user" && promptAttachmentEntries.length > 0);
  if (
    !shouldRestoreRealUserEnvelope &&
    syntheticAttachmentEntries.length === 0 &&
    promptAttachmentEntries.length === 0
  ) {
    return [];
  }
  return [
    ...(shouldRestoreRealUserEnvelope
      ? [
          {
            message: { role: "user" as const, content },
            metadata: userMetadata,
          },
        ]
      : []),
    ...syntheticAttachmentEntries,
    ...promptAttachmentEntries,
  ];
}

function contentFromUserBlocks(
  blocks: readonly ModelMessageContentBlock[],
  options: { preserveBlocks?: boolean } = {},
): ModelMessageContent {
  if (options.preserveBlocks) {
    return blocks.map((block) => ({ ...block })) as ModelMessageContentBlock[];
  }
  const textBlocks = blocks.filter(
    (block): block is Extract<ModelMessageContentBlock, { type: "text" }> => block.type === "text",
  );
  if (blocks.length === textBlocks.length) {
    return textBlocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n");
  }
  return blocks.map((block) => ({ ...block })) as ModelMessageContentBlock[];
}

function promptAttachmentReminderInputForFilePart(
  part: FilePart,
  block: Extract<ModelMessageContentBlock, { type: "text" }>,
): (PromptAttachmentReminderInput & { content: string; kind: "file" | "inline_text" }) | undefined {
  if (!part.mime.startsWith("text/")) return undefined;
  if (!part.source) {
    return {
      content: block.text,
      kind: "inline_text",
      label: part.filename,
      preview: part.metadata?.preview,
    };
  }
  if (part.metadata?.storageKind !== "inline") return undefined;
  if (
    part.metadata.recoverability !== "provider_ready" &&
    part.metadata.recoverability !== "preview_only"
  ) {
    return undefined;
  }
  if (part.metadata.preview?.text !== block.text) return undefined;
  return {
    content: block.text,
    kind: "file",
    label: part.source.text.value ?? part.filename,
    preview: part.metadata.preview,
  };
}

function textPartToProviderText(part: Extract<MessagePart, { type: "text" }>): string {
  if (!part.synthetic) {
    return part.text;
  }
  if (isProviderWrappedSystemReminderText(part.text)) {
    return part.text;
  }

  const runtimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (runtimeMetadata?.source === "task_status" && part.metadata?.source !== "background_task") {
    return wrapSystemReminderForSource("task_status", part.text);
  }
  if (
    runtimeMetadata?.source === "queued_system_notification" ||
    part.metadata?.source === "subagent"
  ) {
    // subagent notification 同样只在 provider history 恢复时包外层，避免改动 session/UI raw transcript。
    return wrapSystemReminderForSource("queued_system_notification", part.text);
  }
  return part.text;
}

interface SyntheticSystemReminderAttachment {
  source: SystemReminderSource;
  content: string;
}

export function syntheticSystemReminderAttachmentFromParts(
  parts: MessagePart[],
): SyntheticSystemReminderAttachment | undefined {
  const visibleParts = parts.filter((part) => !(part.type === "text" && part.ignored));
  if (visibleParts.length !== 1) return undefined;

  const part = visibleParts[0]!;
  if (part.type !== "text" || !part.synthetic) return undefined;
  return syntheticSystemReminderAttachmentFromTextPart(part);
}

function syntheticSystemReminderAttachmentFromTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): SyntheticSystemReminderAttachment | undefined {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  if (isProviderWrappedSystemReminderText(part.text)) return undefined;
  const metadata = metadataFromSyntheticTextPart(part);
  if (!isRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;

  return {
    source: metadata.source,
    content: part.text,
  };
}

function isRestorableSystemReminderAttachmentSource(
  source: RuntimeMessageSource,
): source is SystemReminderSource {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

function isProviderWrappedSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

function metadataFromUserParts(parts: MessagePart[]): RuntimeMessageMetadata {
  const visibleTextParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text" && !part.ignored,
  );
  const hasRealUserText = visibleTextParts.some((part) => !part.synthetic);
  const hasStructuredUserPart = parts.some((part) => part.type === "file" || part.type === "agent");
  if (hasRealUserText || hasStructuredUserPart) {
    return realUserRuntimeMetadata();
  }

  const syntheticTextPart = visibleTextParts.find((part) => part.synthetic);
  if (!syntheticTextPart) {
    return realUserRuntimeMetadata();
  }

  return metadataFromSyntheticTextPart(syntheticTextPart);
}

function metadataFromSyntheticTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): RuntimeMessageMetadata {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    // runtime command carrier 对齐直接 user-like 注入；即使旧持久化里带过
    // system reminder metadata，恢复时也不能把后台完成或 child 回复重新包成 reminder。
    return legacySyntheticRuntimeMetadata();
  }

  const persistedRuntimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (persistedRuntimeMetadata) {
    return persistedRuntimeMetadata;
  }

  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  if (source === "rewind" || source === "fork") {
    return systemReminderRuntimeMetadata("rewind_notice");
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return legacySyntheticRuntimeMetadata();
}

function runtimeMessageMetadataFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeMessageMetadata | undefined {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!isRecord(runtimeMessage)) return undefined;

  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "real_user") {
    return realUserRuntimeMetadata();
  }
  if (source === "legacy_synthetic") {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
