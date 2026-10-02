// MessageHistoryImpl is the sole owner of canonical entries and cache statistics.
import type { ModelMessageContent, Model, TokenUsageInfo } from "@lcode/contracts";
import type { SystemReminderSource } from "../system-reminder/source.js";
import type {
  CacheStats,
  MessageHistory,
  ModelInputMessage,
  PreparedMessageHistoryReplacement,
  ReasoningContentInput,
  RuntimeMessageEntry,
  RuntimeMessageMetadata,
  ToolCallInput,
} from "./message-history-types.js";
import {
  cloneEntryInput,
  cloneReasoningBlock,
  cloneRuntimeMessageEntry,
  cloneTokenUsageInfo,
  countContextPrefixMessages,
  createRuntimeUserEntry,
  createRuntimeToolResultEntry,
  systemReminderAttachmentEntry,
} from "./message-history-entries.js";

export type {
  CacheStats,
  MessageHistory,
  ModelInputMessage,
  PreparedMessageHistoryReplacement,
  ReasoningContentInput,
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
  RuntimeMessageMessageEntry,
  RuntimeMessageMetadata,
  RuntimeMessageSource,
  ToolCallInput,
} from "./message-history-types.js";
export {
  cloneModelInputMessage,
  cloneModelMessageContent,
  cloneRuntimeMessageEntry,
  countContextPrefixMessages,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
  createRuntimeUserEntry,
  invalidateRuntimeTokenUsage,
  isKnownSystemReminderSource,
  isRuntimeAttachmentEntry,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
} from "./message-history-entries.js";

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
  ): void {
    this.entries.push(createRuntimeToolResultEntry(toolCallId, toolName, content, isError));
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.prepareMessagesReplacement(messages).commit();
  }

  prepareMessagesReplacement(
    messages: readonly (ModelInputMessage | RuntimeMessageEntry)[],
  ): PreparedMessageHistoryReplacement {
    const entries = messages.map(cloneEntryInput);
    const cacheStats: CacheStats = {
      totalMessages: entries.length,
      cachedMessages: countContextPrefixMessages(entries),
      lastCacheHit: false,
    };
    return {
      entries,
      commit: () => {
        this.entries = entries;
        this.cacheStats = cacheStats;
      },
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}
