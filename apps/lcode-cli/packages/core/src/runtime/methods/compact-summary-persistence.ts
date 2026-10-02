import { createModelId, createModelProviderId } from "@lcode/contracts";
import { createMessageId, createPartId, traceContextToLogContext } from "../deps.js";
import type { CompactBoundaryPayload, MessageId, Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";

export async function persistCompactSummary(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  content: string,
  summary: string,
  compactBoundary: CompactBoundaryPayload,
  traceContext: TraceContext,
  options?: {
    model?: Model;
    operationId?: string;
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
  },
): Promise<void> {
  if (!this.sessionStore) return;

  const created = Date.now();
  const persistedModel = resolvePersistedModel(this, options?.model);
  // compact summary 和后续 reminder 是同一次历史替换；任一步失败都要一起回滚。
  const persistedMessageIds: MessageId[] = [messageID];
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        summary: {
          title: "Compact summary",
          body: summary,
          diffs: [],
        },
        agent: this.config.agentName ?? "lcode-agent",
        modelSelection: persistedModel,
        semantics: {
          origin: "agent_runtime",
          kind: "compact_summary",
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "compaction",
        auto: compactBoundary.trigger === "auto",
        trigger: compactBoundary.trigger,
        phase: compactBoundary.phase,
        compactReason: compactBoundary.compactReason,
        tail_start_id: compactBoundary.lastSummarizedMessageId,
        compactBoundary,
        operationId: options?.operationId,
      },
      traceContext,
    );
    for (const entry of options?.postCompactReminderEntries ?? []) {
      if (!isRuntimeAttachmentEntry(entry)) continue;
      const reminderMessageId = await persistCompactReminderMessage.call(
        this,
        entry,
        created,
        traceContext,
        options?.model,
      );
      if (reminderMessageId) persistedMessageIds.push(reminderMessageId);
    }
  } catch (error) {
    await removeCompactPersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}

async function persistCompactReminderMessage(
  this: AgentRuntimeInternal,
  entry: RuntimeMessageEntry,
  created: number,
  traceContext: TraceContext,
  model?: Model,
): Promise<MessageId | undefined> {
  if (!this.sessionStore || !isRuntimeAttachmentEntry(entry)) return;

  const messageID = createMessageId();
  const currentModel = resolvePersistedModel(this, model);
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        agent: this.config.agentName ?? "lcode-agent",
        metadata: compactReminderPartMetadata(entry.metadata),
        modelSelection: currentModel,
        semantics: {
          origin: "agent_runtime",
          kind: "system_reminder",
          source: String(entry.metadata.source ?? "compact_reminder"),
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        synthetic: true,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
        visibility: "model-only",
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: entry.content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
        metadata: compactReminderPartMetadata(entry.metadata),
      },
      traceContext,
    );
    return messageID;
  } catch (error) {
    await removeCompactPersistenceMessagesBestEffort.call(this, [messageID], traceContext);
    throw error;
  }
}

function resolvePersistedModel(runtime: AgentRuntimeInternal, model?: Model) {
  if (model) return { providerId: model.providerId, modelId: model.modelId };
  const selection = runtime.getSessionModelSelection();
  return selection
    ? {
        providerId: createModelProviderId(selection.providerId),
        modelId: createModelId(selection.modelId),
      }
    : undefined;
}

async function removeCompactPersistenceMessagesBestEffort(
  this: AgentRuntimeInternal,
  messageIds: readonly MessageId[],
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  for (const rollbackMessageId of new Set(messageIds)) {
    try {
      await this.sessionStore.removeMessage({
        sessionID: this.sessionId,
        messageID: rollbackMessageId,
      });
    } catch (cleanupError) {
      this.logger?.warn("Compact persistence cleanup failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        event: "compact.persistence.cleanup_failed",
        messageId: rollbackMessageId,
        module: "core.runtime",
      });
    }
  }
}

function compactReminderPartMetadata(
  runtimeMessage: RuntimeMessageMetadata,
): Record<string, unknown> {
  return {
    runtimeMessage,
    source: runtimeMessage.source,
    visibility: "model-only",
  };
}
