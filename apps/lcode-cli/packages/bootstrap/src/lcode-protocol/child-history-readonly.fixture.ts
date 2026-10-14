import type { MessageWithParts, SessionId, SessionStorePort } from "@lcode/contracts";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

export function childHistoryFixture() {
  const sessionId = "history-child" as SessionId;
  const messages = [
    {
      info: {
        id: "user",
        sessionID: sessionId,
        role: "user",
        time: { created: 1 },
        modelSelection: { providerId: "fixture", modelId: "child-B" },
        anchor: { turnId: "turn" },
      },
      parts: [{ id: "input", type: "text", text: "history input" }],
    },
    {
      info: {
        id: "assistant",
        sessionID: sessionId,
        role: "assistant",
        parentID: "user",
        providerId: "fixture",
        modelId: "child-B",
        mode: "yolo",
        time: { created: 2, completed: 3 },
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        anchor: { turnId: "turn" },
      },
      parts: [{ id: "reply", type: "text", text: "saved child reply" }],
    },
  ] as unknown as MessageWithParts[];
  const stored = {
    id: sessionId,
    taskType: "workflow_child",
    parentID: "parent",
    directory: "fixture",
    path: "fixture",
    workspaceID: "fixture",
    time: { created: 1, updated: 3 },
  };
  const store = {
    getSession: async (id: string) => (id === sessionId ? stored : null),
    messages: async () => messages,
    readTarget: async () => null,
    sessionEntries: async () => [],
    listSessionTaskLinks: async () => [],
    listSessions: async () => [],
  } as unknown as SessionStorePort;
  let appCreations = 0;
  const context = {
    sessions: new Map(),
    appRuntimePreferences: {},
    notify() {},
    deps: {
      sessionStore: store,
      createLCodeApp: () => {
        appCreations++;
        throw new Error("History must not create an app");
      },
    },
  } as unknown as LCodeProtocolAgentServerContext;
  return { context, store, stored, messages, sessionId, appCreations: () => appCreations };
}
