import { resolve } from "node:path";
import {
  SessionHistorySearchOutputSchema,
  type MessageId,
  type MessageWithParts,
  type PartId,
  type SessionHistorySearchOutput,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type WorkspaceId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { sessionHistorySearchToolEntry } from "./session-history-search.js";

export const WORKSPACE_A = resolve("workspace-a");
export const WORKSPACE_B = resolve("workspace-b");
export const REMOTE_A = "remote:workspace-a" as WorkspaceId;
export const REMOTE_B = "remote:workspace-b" as WorkspaceId;

export async function execute(
  sessionStore: SessionStorePort | undefined,
  input: { limit?: number; query: string },
  overrides: Partial<ToolExecutionContext> = {},
): Promise<SessionHistorySearchOutput> {
  return SessionHistorySearchOutputSchema.parse(
    await sessionHistorySearchToolEntry.handler(input, createContext(sessionStore, overrides)),
  );
}

export function createContext(
  sessionStore: SessionStorePort | undefined,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_current" as SessionId,
    sessionStore,
    toolCallId: "tool-session-history-search",
    traceId: "trace-session-history-search",
    workingDirectory: WORKSPACE_A,
    workspaceRoot: WORKSPACE_A,
    ...overrides,
  } as ToolExecutionContext;
}

export function createSession(
  id: string,
  overrides: Omit<Partial<SessionInfo>, "id" | "time"> & {
    time?: Partial<SessionInfo["time"]>;
  } = {},
): SessionInfo {
  return {
    id: id as SessionId,
    projectID: "project-a",
    taskType: "interactive",
    slug: id,
    directory: WORKSPACE_A,
    title: "Target session",
    version: "1",
    ...overrides,
    time: { created: 1, updated: 1, ...overrides.time },
  } as SessionInfo;
}

export function createUserMessage(
  id: string | MessageId,
  text: string,
  sessionID: SessionId,
): MessageWithParts {
  const messageID = id as MessageId;
  return {
    info: {
      agent: "build",
      id: messageID,
      role: "user",
      sessionID,
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${messageID}` as PartId,
        messageID,
        sessionID,
        text,
        type: "text",
      },
    ],
  };
}

export function createStore(input: {
  sessions: SessionInfo[];
  getSession?: SessionStorePort["getSession"];
  listSessions?: SessionStorePort["listSessions"];
  messages?: SessionStorePort["messages"];
}): SessionStorePort {
  return {
    getSession:
      input.getSession ??
      (async (sessionID) => input.sessions.find((session) => session.id === sessionID) ?? null),
    listSessions: input.listSessions ?? (async () => input.sessions),
    messages: input.messages ?? (async () => []),
  } as SessionStorePort;
}
