import {
  getLatestAssistantContentPart,
  type LCodeAssistantMessagePart,
} from "./assistant-message-parts.js";

export interface LCodeAssistantPresentationToolCall {
  toolId: string;
  parentToolUseId?: string | null;
  kind: string;
  title?: string;
  input: unknown;
  status: string;
  output?: unknown;
  error?: string;
  raw?: unknown;
}

export type LCodeAssistantPresentationBlock =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "thought";
      content: string;
    }
  | {
      type: "tool-call";
      toolCall: LCodeAssistantPresentationToolCall;
    };

export interface LCodeAssistantPresentation {
  messageParts: LCodeAssistantMessagePart[];
  blocks: LCodeAssistantPresentationBlock[];
  latestPart: Extract<LCodeAssistantPresentationBlock, { type: "content" }> | null;
  historyBlocks: LCodeAssistantPresentationBlock[];
}

export interface BuildLCodeAssistantPresentationOptions {
  content: string;
  thought?: string;
  toolCalls?: readonly LCodeAssistantPresentationToolCall[];
  parts?: readonly LCodeAssistantMessagePart[];
  streaming?: boolean;
  interrupted?: boolean;
  settling?: boolean;
}

function buildFallbackAssistantParts({
  content,
  thought,
  toolCalls,
}: Pick<BuildLCodeAssistantPresentationOptions, "content" | "thought" | "toolCalls">) {
  const rootToolCalls = (toolCalls ?? []).filter((toolCall) => {
    const parentToolUseId = toolCall.parentToolUseId ?? null;
    return (
      !parentToolUseId ||
      parentToolUseId === toolCall.toolId ||
      !(toolCalls ?? []).some((candidate) => candidate.toolId === parentToolUseId)
    );
  });

  return [
    ...(thought ? [{ type: "thought", content: thought } as const] : []),
    ...rootToolCalls.map(
      (toolCall) =>
        ({
          type: "tool-call",
          toolId: toolCall.toolId,
        }) as const,
    ),
    ...(content ? [{ type: "content", content } as const] : []),
  ];
}

export function buildLCodeAssistantPresentation({
  content,
  thought,
  toolCalls = [],
  parts,
  streaming = false,
  interrupted = false,
  settling = false,
}: BuildLCodeAssistantPresentationOptions): LCodeAssistantPresentation {
  const messageParts =
    parts && parts.length > 0
      ? [...parts]
      : buildFallbackAssistantParts({ content, thought, toolCalls });
  const toolCallById = new Map(toolCalls.map((toolCall) => [toolCall.toolId, toolCall]));
  const renderedToolCallIds = new Set<string>();
  const blocks: LCodeAssistantPresentationBlock[] = [];

  for (const part of messageParts) {
    if (part.type === "content") {
      blocks.push({ type: "content", content: part.content });
      continue;
    }
    if (part.type === "thought") {
      blocks.push({ type: "thought", content: part.content });
      continue;
    }

    const toolCall = toolCallById.get(part.toolId);
    if (!toolCall || renderedToolCallIds.has(part.toolId)) {
      continue;
    }
    const parentToolUseId = toolCall.parentToolUseId ?? null;
    if (
      parentToolUseId &&
      parentToolUseId !== toolCall.toolId &&
      toolCallById.has(parentToolUseId)
    ) {
      continue;
    }
    renderedToolCallIds.add(part.toolId);
    blocks.push({ type: "tool-call", toolCall });
  }

  const latestContentPart =
    streaming || interrupted || settling
      ? null
      : getLatestAssistantContentPart(
          blocks
            .filter(
              (block): block is Extract<LCodeAssistantPresentationBlock, { type: "content" }> =>
                block.type === "content",
            )
            .map((block) => ({ type: "content", content: block.content })),
        );
  let latestPart: Extract<LCodeAssistantPresentationBlock, { type: "content" }> | null = null;
  let latestBlockIndex = -1;
  if (latestContentPart) {
    latestBlockIndex = blocks.findLastIndex(
      (block) => block.type === "content" && block.content === latestContentPart.content,
    );
    latestPart =
      latestBlockIndex >= 0
        ? (blocks[latestBlockIndex] as Extract<
            LCodeAssistantPresentationBlock,
            { type: "content" }
          >)
        : null;
  }

  return {
    messageParts,
    blocks,
    latestPart,
    historyBlocks: blocks.filter((_, index) => index !== latestBlockIndex),
  };
}
