import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  stableContextMessages,
  type MessageWithParts,
  type SessionInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import {
  loadScopedSessionContextSnapshot,
  scopedContextSnapshotStillCurrent,
} from "./read-session-context-snapshot.js";

const session = {
  id: "sess_source",
  directory: resolve("scope"),
  time: { created: 1, updated: 1 },
} as SessionInfo;
function assistant(id: string, completed = true): MessageWithParts {
  return {
    info: {
      id,
      sessionID: session.id,
      role: "assistant",
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      finish: "stop",
    },
    parts: [{ id: `part_${id}`, messageID: id, sessionID: session.id, type: "text", text: id }],
  } as MessageWithParts;
}

test("stable prefix retreats before any unfinished earlier entry even when a later assistant is complete", () => {
  const first = assistant("msg_first"),
    streaming = assistant("msg_streaming", false),
    later = assistant("msg_later");
  assert.deepEqual(
    stableContextMessages([first, streaming, later]).map((message) => message.info.id),
    ["msg_first"],
  );
  const pending = assistant("msg_pending");
  pending.parts = [
    {
      id: "part_tool",
      messageID: pending.info.id,
      sessionID: session.id,
      type: "tool",
      tool: "Read",
      callID: "call",
      state: { status: "pending", input: {}, raw: "secret" },
    } as MessageWithParts["parts"][number],
  ];
  assert.deepEqual(
    stableContextMessages([first, pending, later]).map((message) => message.info.id),
    ["msg_first"],
  );
});

test("post-summary validation tolerates append but fails closed on changed content and scope", async () => {
  let currentSession = session,
    records = [assistant("msg_first")];
  const store = {
    getSession: async () => currentSession,
    messages: async () => records,
  } as SessionStorePort;
  const workspace = { workspaceRoot: session.directory };
  const snapshot = (await loadScopedSessionContextSnapshot({
    sessionId: session.id,
    sessionStore: store,
    workspace,
    stableCompleted: true,
  }))!;
  records = [...records, assistant("msg_new")];
  assert.equal(
    await scopedContextSnapshotStillCurrent({ snapshot, sessionStore: store, workspace }),
    true,
  );
  records = records.map((message, index) =>
    index
      ? message
      : {
          ...message,
          parts: [{ ...message.parts[0]!, text: "changed" } as MessageWithParts["parts"][number]],
        },
  );
  assert.equal(
    await scopedContextSnapshotStillCurrent({ snapshot, sessionStore: store, workspace }),
    false,
  );
  currentSession = { ...session, workspaceID: "remote:other" as SessionInfo["workspaceID"] };
  assert.equal(
    await scopedContextSnapshotStillCurrent({ snapshot, sessionStore: store, workspace }),
    false,
  );
});
