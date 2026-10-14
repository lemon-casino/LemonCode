import {
  createSessionEvent,
  SessionEventType,
  type MessageId,
  type SessionId,
  type TurnId,
} from "@lcode/contracts";
import {
  applyWorkspaceFileRewindFromSources,
  persistWorkspaceFileRewindEntryStrict,
} from "@lcode/core";
import { resolveConversationReader } from "./conversation-reader.js";
import { isReadOnlyChildTaskType } from "./child-session-policy.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

/** 原 CommandInbox 已验证 canonical row/epoch/revision；此处只拥有显式文件命令的端口调用。 */
export async function applyHistoricalConversationFileRewind(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  input: { targetMessageIds: MessageId[]; targetTurnId?: TurnId },
) {
  const reader = await resolveConversationReader(context, sessionId);
  const store = context.deps.sessionStore;
  const ports = context.deps.conversationReadPorts;
  if (!isReadOnlyChildTaskType(reader.stored?.taskType) || !store?.saveSessionEntry || !ports)
    throw new Error("fault.fileRewind.ownerUnavailable");
  const entries = (await store.sessionEntries?.({ sessionID: sessionId as SessionId })) ?? [];
  const events = reader.workspaceEventsFromEntries(entries, reader.memoryEvents);
  const result = await applyWorkspaceFileRewindFromSources(
    {
      sessionId: sessionId as SessionId,
      workspaceRoot: reader.workspace.workspacePath,
      rootTraceContext: reader.traceContext,
      eventStore: { getEvents: async () => events },
      artifactStore: ports.artifactStore,
      fileSystemPort: ports.fileSystemPort,
      logger: context.logger,
      createEvent: (_type, payload, trace) =>
        createSessionEvent(SessionEventType.RewindTriggered, sessionId as SessionId, payload, {
          traceId: trace.traceId,
          ...(input.targetTurnId ? { turnId: input.targetTurnId } : {}),
        }),
      appendEvent: (event) => persistWorkspaceFileRewindEntryStrict(store, event),
    },
    input,
  );
  if (result.applied) await context.v4Gateway?.refreshPersistedSessionView(sessionId);
  return result;
}
