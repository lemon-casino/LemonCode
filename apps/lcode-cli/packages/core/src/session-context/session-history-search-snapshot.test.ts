import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  type MessageId,
  type PartId,
  type ReadSessionTranscriptSnapshotInput,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
} from "@lcode/contracts";
import { SESSION_HISTORY_AUTO_RECALL_BOUNDS } from "./session-history-auto-recall.js";
import { searchSessionHistory } from "./session-history-search-service.js";

const ROOT = "C:\\workspace\\snapshot";

test("BTS-6 explicit search prefers the atomic bounded snapshot and propagates truncation", async () => {
  const session = createSession();
  let snapshotInput: ReadSessionTranscriptSnapshotInput | undefined;
  const store = {
    listSessions: async () => [session],
    readTranscriptSnapshot: async (input: ReadSessionTranscriptSnapshotInput) => {
      snapshotInput = input;
      return {
        session,
        messages: [createUserMessage(session.id, "needle architecture")],
        loadedMessageCount: 1,
        loadedPartCount: 1,
        loadedDataBytes: 128,
        truncated: true,
      };
    },
    messages: async () => {
      throw new Error("legacy messages path must not run");
    },
    getSession: async () => {
      throw new Error("atomic snapshot must not refresh metadata separately");
    },
  } as unknown as SessionStorePort;

  const output = await search(store);
  assert.equal(output.status, "ok");
  assert.equal(output.matches.length, 1);
  assert.equal(output.truncated, true);
  assert.deepEqual(snapshotInput?.limits, {
    maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
    maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
    maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  });
});

test("BTS-8 automatic recall sends its stricter limits through the shared snapshot path", async () => {
  const session = createSession();
  let snapshotInput: ReadSessionTranscriptSnapshotInput | undefined;
  const store = {
    listSessions: async () => [session],
    readTranscriptSnapshot: async (input: ReadSessionTranscriptSnapshotInput) => {
      snapshotInput = input;
      return {
        session,
        messages: [],
        loadedMessageCount: 0,
        loadedPartCount: 0,
        loadedDataBytes: 0,
        truncated: false,
      };
    },
  } as unknown as SessionStorePort;

  await search(store, SESSION_HISTORY_AUTO_RECALL_BOUNDS);
  assert.deepEqual(snapshotInput?.limits, {
    maxDataBytes: 98_304,
    maxMessageRows: 96,
    maxPartRows: 384,
  });
});

function search(
  sessionStore: SessionStorePort,
  bounds?: typeof SESSION_HISTORY_AUTO_RECALL_BOUNDS,
) {
  return searchSessionHistory({
    abortSignal: new AbortController().signal,
    bounds,
    currentSessionId: "sess_current" as SessionId,
    query: "needle",
    requestedLimit: 5,
    sessionStore,
    workspaceRoot: ROOT,
  });
}

function createSession(): SessionInfo {
  return {
    id: "sess_target" as SessionId,
    projectID: "project-snapshot",
    taskType: "interactive",
    slug: "target",
    directory: ROOT,
    title: "Target",
    version: "1",
    time: { created: 1, updated: 1 },
  } as SessionInfo;
}

function createUserMessage(sessionID: SessionId, text: string) {
  const messageID = "msg_target" as MessageId;
  return {
    info: {
      agent: "build",
      id: messageID,
      role: "user" as const,
      sessionID,
      time: { created: 1 },
    },
    parts: [
      {
        id: "part_target" as PartId,
        messageID,
        sessionID,
        text,
        type: "text" as const,
      },
    ],
  };
}
