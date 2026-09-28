import type {
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";

type PersistedAttachmentResource = {
  metadata: {
    artifactUri?: string;
    recoverability: "provider_ready";
    storageKind: "artifact" | "inline";
  };
  url: string;
};

type InlineAttachmentContent = {
  artifactUri?: string;
  dataUrl: string;
};

export async function persistAttachmentDataUrl(
  dataUrl: string,
  index: number,
  mediaType: string,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<PersistedAttachmentResource> {
  if (options.existingArtifactUri) {
    return {
      metadata: {
        artifactUri: options.existingArtifactUri,
        recoverability: "provider_ready",
        storageKind: "artifact",
      },
      url: options.existingArtifactUri,
    };
  }

  if (!options.artifactStore || !options.sessionId) {
    return {
      metadata: { recoverability: "provider_ready", storageKind: "inline" },
      url: dataUrl,
    };
  }

  // 内存媒体仍可供当前请求使用时吞掉写入失败，会落下冷恢复无法重建的成功历史。
  // image/video 共用这一持久化边界；写入失败必须在 provider 调用前终止当前轮。
  const artifact = await options.artifactStore.writeToolResultArtifact(
    {
      content: dataUrl,
      contentType: "text/plain",
      retention: "session",
      sessionId: options.sessionId,
      toolCallId: `attachment-${index + 1}`,
      toolName: `attachment:${mediaType}`,
      trace: options.traceContext,
      turnId: options.turnId,
    },
    { signal: options.abortSignal },
  );
  return {
    metadata: {
      artifactUri: artifact.uri,
      recoverability: "provider_ready",
      storageKind: "artifact",
    },
    url: artifact.uri,
  };
}

export async function readInlineAttachmentContent(
  attachment: TurnAttachment,
  options: {
    artifactStore?: ToolArtifactStorePort;
    traceContext: TraceContext;
  },
): Promise<InlineAttachmentContent | undefined> {
  if (!attachment.content) return undefined;
  if (attachment.content.startsWith("data:")) {
    return { dataUrl: attachment.content };
  }
  if (!attachment.content.startsWith("lcode-artifact://") || !options.artifactStore) {
    return undefined;
  }
  try {
    const artifact = await options.artifactStore.readToolResultArtifact({
      trace: options.traceContext,
      uri: attachment.content,
    });
    return artifact.content.startsWith("data:")
      ? { artifactUri: attachment.content, dataUrl: artifact.content }
      : undefined;
  } catch {
    return undefined;
  }
}

export function safeAttachmentOriginalRef(attachment: TurnAttachment): string | undefined {
  if (attachment.path) return attachment.path;
  if (!attachment.content) return undefined;
  return attachment.content.startsWith("data:") ? "inline:data-url" : attachment.content;
}
