import {
  createRootTraceContext,
  parseModelSelectionValue,
  SessionEventType,
  type MessageWithParts,
  type SessionId,
  type TraceId,
} from "@lcode/contracts";
import {
  previewWorkspaceFileRewindFromSources,
  workspaceEventsFromSessionEntries,
} from "@lcode/core";
import type { LCodeWorkspaceRef } from "@lcode/shared";
import { createAppAttachmentReadFacade } from "../app/app-attachment-facade.js";
import { readSessionModelSelection } from "../app/session-store.js";
import { resolveConversationBackingRecord } from "./v4-bridge-backing-record.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { resolveConversationReadWorkspace } from "./conversation-read-workspace.js";

/** 只读源不拥有执行资源，不缓存 app/record，也不写历史。 */
export async function resolveConversationReader(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  requestedWorkspace?: LCodeWorkspaceRef,
) {
  const store = context.deps.sessionStore;
  const stored = await store?.getSession(sessionId as SessionId);
  const record = await resolveConversationBackingRecord(context, sessionId);
  if (!stored && !record) throw new Error(`fault.history.sessionNotFound: ${sessionId}`);
  const workspace = await resolveConversationReadWorkspace(
    context,
    sessionId,
    stored,
    requestedWorkspace,
  );
  const ports = context.deps.conversationReadPorts;
  const traceContext = createRootTraceContext({
    sessionId: sessionId as SessionId,
    ...(stored?.traceID ? { traceId: stored.traceID as TraceId } : {}),
  });
  const attachments =
    store && ports
      ? createAppAttachmentReadFacade({
          ...ports,
          sessionStore: store,
          sessionId: sessionId as SessionId,
          traceContext,
        })
      : undefined;
  const memory = record
    ? await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ])
    : ([[], 0] as const);
  const readArtifact = async (uri: string) => {
    if (ports)
      return (await ports.artifactStore.readToolResultArtifact({ uri, trace: traceContext }))
        .content;
    if (record) return (await record.app.readToolResultArtifact(uri)).content;
    if (context.deps.readWorkspaceCheckpointArtifact)
      return context.deps.readWorkspaceCheckpointArtifact(uri);
    throw new Error("fault.history.artifactReadUnsupported");
  };
  return {
    stored,
    record,
    workspace,
    traceContext,
    attachments,
    readArtifact,
    memoryEvents: memory[0],
    sourceEventSeq: memory[1],
    workspaceEventsFromEntries: (
      entries: Parameters<typeof workspaceEventsFromSessionEntries>[1],
      events: Parameters<typeof workspaceEventsFromSessionEntries>[2],
    ) => workspaceEventsFromSessionEntries(sessionId as SessionId, entries, events),
    configuration: async (
      messages: readonly MessageWithParts[],
      events: readonly import("@lcode/contracts").SessionEvent[],
    ) => {
      const direct = context.sessions.get(sessionId);
      let selection =
        direct?.app.runtime.getSessionModelSelection() ?? direct?.restoredModelSelection;
      if (!selection && store) {
        try {
          selection = await readSessionModelSelection(store, sessionId as SessionId);
        } catch (error) {
          context.logger?.warn("Historical model binding is unavailable", {
            event: "lcode_protocol.history.model_binding_unavailable",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!selection)
        for (const event of [...events].reverse()) {
          if (event.type === SessionEventType.ModelSelected) {
            selection = parseModelSelectionValue(
              (event.payload as { modelSelection?: unknown }).modelSelection,
            );
            if (selection) break;
          }
        }
      const assistant = [...messages]
        .reverse()
        .find(
          (message) =>
            message.info.role === "assistant" &&
            !message.info.summary &&
            !message.info.metadata?.forkOrigin &&
            message.info.semantics?.origin !== "import",
        );
      if (
        !selection &&
        assistant?.info.role === "assistant" &&
        assistant.info.providerId &&
        assistant.info.modelId
      )
        selection = {
          providerId: String(assistant.info.providerId),
          modelId: String(assistant.info.modelId),
          ...(assistant.info.reasoningLevel
            ? { options: { reasoningLevel: assistant.info.reasoningLevel } }
            : {}),
        };
      let capacity: number | undefined;
      try {
        capacity =
          selection &&
          (ports?.modelContextWindow?.(selection) ??
            direct?.app.getModelOption?.(selection)?.contextWindow);
      } catch (error) {
        context.logger?.warn("Historical model capacity is unavailable", {
          event: "lcode_protocol.history.model_capacity_unavailable",
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        contextWindow:
          typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0
            ? capacity
            : undefined,
        configSeed: {
          executionWorkspace: workspace,
          ...(selection
            ? {
                modelSelection: selection,
                provider: selection.providerId,
                model: selection.modelId,
                thought: selection.options?.reasoningLevel ?? "",
              }
            : {}),
          ...(assistant?.info.role === "assistant"
            ? {
                mode: assistant.info.mode,
                planEnabled: assistant.info.planEnabled ?? assistant.info.mode === "plan",
              }
            : {}),
        },
      };
    },
    previewFileRewind: async (
      messageIds: readonly string[],
      targetTurnId?: import("@lcode/contracts").TurnId | null,
    ) => {
      const entries = (await store?.sessionEntries?.({ sessionID: sessionId as SessionId })) ?? [];
      const events = workspaceEventsFromSessionEntries(sessionId as SessionId, entries, memory[0]);
      return previewWorkspaceFileRewindFromSources(
        {
          sessionId: sessionId as SessionId,
          workspaceRoot: workspace.workspacePath,
          rootTraceContext: traceContext,
          eventStore: { getEvents: async () => events },
          artifactStore: ports?.artifactStore,
          fileSystemPort: ports?.fileSystemPort,
        },
        {
          targetMessageIds: messageIds as import("@lcode/contracts").MessageId[],
          ...(targetTurnId ? { targetTurnId } : {}),
        },
      );
    },
  };
}
