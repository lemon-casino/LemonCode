import { createHash } from "node:crypto";
import type { TurnAttachment } from "@lcode/core";
import type {
  InputHistoryAttachment,
  InputHistoryEntry,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
} from "@lcode/contracts";
import type { PromptInput } from "./types.js";

export function normalizePromptInput(input: PromptInput): {
  text: string;
  attachments?: TurnAttachment[];
} {
  if (typeof input === "string") {
    return { text: input };
  }
  return {
    text: input.text,
    attachments: input.attachments,
  };
}

export function projectInputHistoryAttachments(
  attachments: TurnAttachment[] | undefined,
): InputHistoryAttachment[] | undefined {
  const projected: InputHistoryAttachment[] = [];
  for (const attachment of attachments ?? []) {
    // TurnAttachment 新增 video 后曾直接扩大 legacy InputHistory contract；
    // 这里显式投影该端口真正支持的类型，避免类型契约与存储行为分裂。PDF 已加入该端口，
    // 以便 input history 也保留 durable artifact ref。
    if (attachment.type === "video") continue;
    projected.push({
      type: attachment.type,
      ...(attachment.path !== undefined ? { path: attachment.path } : {}),
      ...(attachment.content !== undefined ? { content: attachment.content } : {}),
    });
  }
  return projected.length > 0 ? projected : undefined;
}

export async function externalizePromptAttachments(
  attachments: TurnAttachment[] | undefined,
  options: {
    artifactStore?: ToolArtifactStorePort;
    sessionId: SessionId;
    traceContext: TraceContext;
  },
): Promise<TurnAttachment[] | undefined> {
  const externalized = await Promise.all(
    (attachments ?? []).map(async (attachment, index): Promise<TurnAttachment> => {
      if (!isInlineImageAttachment(attachment)) return attachment;
      if (!options.artifactStore) return attachmentWithoutInlineContent(attachment);

      try {
        const artifact = await options.artifactStore.writeToolResultArtifact({
          content: attachment.content,
          contentType: "text/plain",
          retention: "session",
          sessionId: options.sessionId,
          toolCallId: attachmentArtifactCallId(attachment, index),
          toolName: `prompt-attachment:${attachment.type}`,
          trace: options.traceContext,
        });
        return {
          ...attachment,
          content: artifact.uri,
        };
      } catch {
        return attachmentWithoutInlineContent(attachment);
      }
    }),
  );

  return externalized.length > 0 ? externalized : undefined;
}

export async function materializeInputHistoryEntry(
  entry: InputHistoryEntry | null,
  artifactStore: ToolArtifactStorePort | undefined,
): Promise<InputHistoryEntry | null> {
  if (!entry?.attachments || !artifactStore) return entry;
  const attachments = await Promise.all(
    entry.attachments.map(async (attachment): Promise<InputHistoryAttachment> => {
      if (!attachment.content?.startsWith("lcode-artifact://")) return attachment;
      try {
        const artifact = await artifactStore.readToolResultArtifact({ uri: attachment.content });
        return {
          ...attachment,
          content: artifact.content,
        };
      } catch {
        return attachmentWithoutInlineContent(attachment);
      }
    }),
  );
  return {
    ...entry,
    attachments,
  };
}

function isInlineImageAttachment(
  attachment: TurnAttachment,
): attachment is TurnAttachment & { content: string } {
  return (
    (attachment.type === "image" || attachment.type === "pdf") &&
    attachment.content?.startsWith("data:") === true
  );
}

function attachmentWithoutInlineContent<T extends TurnAttachment | InputHistoryAttachment>(
  attachment: T,
): T {
  const { content: _content, ...rest } = attachment;
  return rest as T;
}

function attachmentArtifactCallId(
  attachment: TurnAttachment & { content: string },
  index: number,
): string {
  const digest = createHash("sha256").update(attachment.content).digest("hex").slice(0, 16);
  return `prompt-attachment-${index + 1}-${digest}`;
}
