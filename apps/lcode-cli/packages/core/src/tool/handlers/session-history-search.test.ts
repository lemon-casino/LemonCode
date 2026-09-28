import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT,
  SESSION_HISTORY_SEARCH_MAX_LIMIT,
  SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TOOL_NAME,
  SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT,
  SessionHistorySearchOutputSchema,
  type ListSessionsInput,
  type MessageId,
  type SessionId,
} from "@lcode/contracts";
import { builtInTools, registerBuiltInTools } from "./index.js";
import { sessionHistorySearchToolEntry } from "./session-history-search.js";
import {
  REMOTE_A,
  REMOTE_B,
  WORKSPACE_A,
  WORKSPACE_B,
  createContext,
  createSession,
  createStore,
  createUserMessage,
  execute,
} from "./session-history-search.fixtures.js";

test("SHS-01/02 sends identity-first remote and local list filters", async () => {
  let remoteInput: ListSessionsInput | undefined;
  const remoteReads: SessionId[] = [];
  const remoteA = createSession("sess_remote_a", {
    directory: WORKSPACE_A,
    title: "needle remote A",
    workspaceID: REMOTE_A,
  });
  const samePathRemoteB = createSession("sess_remote_b", {
    directory: WORKSPACE_A,
    title: "needle remote B",
    workspaceID: REMOTE_B,
  });
  const remoteStore = createStore({
    sessions: [remoteA, samePathRemoteB],
    listSessions: async (input) => {
      remoteInput = input;
      return [remoteA, samePathRemoteB];
    },
    messages: async ({ sessionID }) => {
      remoteReads.push(sessionID);
      return [];
    },
  });

  await execute(remoteStore, { query: "needle" }, { workspaceIdentity: ` ${REMOTE_A} ` });
  assert.deepEqual(remoteInput, {
    includeArchived: false,
    limit: SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT + 2,
    taskTypes: ["interactive", "fork", "workflow_parent"],
    workspaceID: REMOTE_A,
  });
  assert.deepEqual(remoteReads, [remoteA.id]);

  let localInput: ListSessionsInput | undefined;
  const local = createSession("sess_local", { directory: WORKSPACE_A, title: "needle local" });
  await execute(
    createStore({
      sessions: [local],
      listSessions: async (input) => {
        localInput = input;
        return [local];
      },
    }),
    { query: "needle" },
    { workingDirectory: WORKSPACE_B },
  );
  assert.deepEqual(localInput, {
    directory: WORKSPACE_A,
    includeArchived: false,
    limit: SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT + 2,
    taskTypes: ["interactive", "fork", "workflow_parent"],
    workspaceID: null,
  });
});

test("SHS-03 excludes current, child, and out-of-scope sessions before messages", async () => {
  const sessions = [
    createSession("sess_current", { workspaceID: REMOTE_A }),
    createSession("sess_workflow_child", { taskType: "workflow_child", workspaceID: REMOTE_A }),
    createSession("sess_subagent_child", { taskType: "subagent_child", workspaceID: REMOTE_A }),
    createSession("sess_selection_child", {
      taskType: "selection_side_chat",
      workspaceID: REMOTE_A,
    }),
    createSession("sess_outside", { directory: WORKSPACE_A, workspaceID: REMOTE_B }),
    createSession("sess_valid", { title: "needle valid", workspaceID: REMOTE_A }),
  ];
  const reads: SessionId[] = [];
  const output = await execute(
    createStore({
      sessions,
      messages: async ({ sessionID }) => {
        reads.push(sessionID);
        return [];
      },
    }),
    { query: "needle" },
    { workspaceIdentity: REMOTE_A },
  );

  assert.equal(output.status, "ok");
  assert.equal(output.candidateSessionCount, 1);
  assert.deepEqual(reads, ["sess_valid"]);
});

test("SHS-07 returns no lexical fallback and still supports title-only matches", async () => {
  const transcriptOnly = createSession("sess_transcript");
  const noMatch = await execute(
    createStore({
      sessions: [transcriptOnly],
      messages: async () => [createUserMessage("msg_other", "alpha beta", transcriptOnly.id)],
    }),
    { query: "zzz-no-match" },
  );
  assert.equal(noMatch.status, "ok");
  assert.deepEqual(noMatch.matches, []);
  assert.equal(noMatch.truncated, false);

  const titleOnly = createSession("sess_title", { title: "Needle architecture" });
  const titleMatch = await execute(createStore({ sessions: [titleOnly] }), { query: "needle" });
  assert.equal(titleMatch.status, "ok");
  assert.equal(titleMatch.matches.length, 1);
  assert.equal(titleMatch.matches[0]?.sessionId, titleOnly.id);
  assert.equal(titleMatch.matches[0]?.preview, "");
});

test("SHS-08 fixes unavailable reasons and retryability", async () => {
  const missing = await execute(undefined, { query: "needle" });
  assert.deepEqual(missing, {
    status: "unavailable",
    reason: "session_store_unavailable",
    retryable: false,
  });

  const listFailed = await execute(
    createStore({ sessions: [], listSessions: async () => Promise.reject(new Error("list")) }),
    { query: "needle" },
  );
  assert.deepEqual(listFailed, {
    status: "unavailable",
    reason: "session_list_failed",
    retryable: true,
  });

  const allFailed = await execute(
    createStore({
      sessions: [createSession("sess_failed")],
      messages: async () => Promise.reject(new Error("messages")),
    }),
    { query: "needle" },
  );
  assert.deepEqual(allFailed, {
    status: "unavailable",
    reason: "session_messages_failed",
    retryable: true,
  });

  const refreshInvalid = await execute(
    createStore({
      sessions: [createSession("sess_refresh_invalid")],
      getSession: async () => null,
    }),
    { query: "needle" },
  );
  assert.deepEqual(refreshInvalid, {
    status: "unavailable",
    reason: "session_messages_failed",
    retryable: true,
  });

  const validPairs = [
    ["session_store_unavailable", false],
    ["session_list_failed", true],
    ["session_messages_failed", true],
  ] as const;
  for (const [reason, retryable] of validPairs) {
    assert.equal(
      SessionHistorySearchOutputSchema.safeParse({ status: "unavailable", reason, retryable })
        .success,
      true,
    );
    assert.equal(
      SessionHistorySearchOutputSchema.safeParse({
        status: "unavailable",
        reason,
        retryable: !retryable,
      }).success,
      false,
    );
  }
});

test("SHS-09 reports a partial candidate failure without losing successful matches", async () => {
  const failed = createSession("sess_failed");
  const matched = createSession("sess_matched");
  const output = await execute(
    createStore({
      sessions: [failed, matched],
      messages: async ({ sessionID }) => {
        if (sessionID === failed.id) throw new Error("candidate read failed");
        return [createUserMessage("msg_matched", "needle decision", matched.id)];
      },
    }),
    { query: "needle" },
  );

  assert.equal(output.status, "ok");
  assert.equal(output.failedSessionCount, 1);
  assert.equal(output.truncated, true);
  assert.deepEqual(
    output.matches.map((match) => match.sessionId),
    [matched.id],
  );
});

test("SHS-10 enforces candidate, result, projection, title, and preview budgets", async () => {
  const resultSessions = Array.from(
    { length: SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT + 1 },
    (_, i) => createSession(`sess_result_${i}`, { title: `needle result ${i}` }),
  );
  const resultBounded = await execute(
    createStore({
      sessions: resultSessions,
      messages: async ({ sessionID }) => [
        createUserMessage(`msg_${sessionID}`, "needle", sessionID),
      ],
    }),
    { limit: SESSION_HISTORY_SEARCH_MAX_LIMIT, query: "needle" },
  );
  assert.equal(resultBounded.status, "ok");
  assert.equal(resultBounded.candidateSessionCount, SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT);
  assert.equal(resultBounded.scannedSessionCount, SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT);
  assert.equal(resultBounded.matches.length, SESSION_HISTORY_SEARCH_MAX_LIMIT);
  assert.equal(resultBounded.truncated, true);

  const longTitle = `needle ${"'".repeat(SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT + 50)}`;
  const longText = `needle ${"'".repeat(SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT + 50)}`;
  const projectionSessions = Array.from(
    { length: SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT },
    (_, i) => createSession(`sess_projection_${i}`, { title: longTitle }),
  );
  const projectionBounded = await execute(
    createStore({
      sessions: projectionSessions,
      messages: async ({ sessionID }) => [
        createUserMessage(`msg_${sessionID}`, longText, sessionID),
      ],
    }),
    { query: "needle" },
  );
  assert.equal(projectionBounded.status, "ok");
  assert.ok(
    projectionBounded.projectedCharacterCount <= SESSION_HISTORY_SEARCH_TOTAL_CHARACTER_LIMIT,
  );
  assert.ok(
    projectionBounded.projectedCharacterCount <=
      projectionBounded.scannedSessionCount * SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  );
  assert.ok(projectionBounded.scannedSessionCount < SESSION_HISTORY_SEARCH_CANDIDATE_LIMIT);
  assert.ok(
    projectionBounded.matches.every(
      (match) =>
        match.title.length <= SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT &&
        match.preview.length <= SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
    ),
  );
  assert.equal(projectionBounded.truncated, true);
});

test("concurrent rewind metadata is refreshed after messages and hides discarded matches", async () => {
  const stale = createSession("sess_rewound");
  const kept = "msg_kept" as MessageId;
  const target = "msg_target" as MessageId;
  const cut = "msg_cut" as MessageId;
  const refreshed = createSession("sess_rewound", {
    revert: {
      branchCutAfterMessageID: cut,
      branchGeneration: 1,
      keptMessageIDs: [kept],
      kind: "conversation_rewind",
      messageID: target,
      scope: "conversation",
      targetMessageID: target,
    },
  });
  const order: string[] = [];
  const output = await execute(
    createStore({
      sessions: [stale],
      messages: async () => {
        order.push("messages");
        return [
          createUserMessage(kept, "kept requirement", stale.id),
          createUserMessage(target, "discarded secret", stale.id),
          createUserMessage(cut, "discarded secret tail", stale.id),
          createUserMessage("msg_replacement", "active replacement", stale.id),
        ];
      },
      getSession: async () => {
        order.push("getSession");
        return refreshed;
      },
    }),
    { query: "discarded secret" },
  );
  assert.deepEqual(order, ["messages", "getSession"]);
  assert.equal(output.status, "ok");
  assert.deepEqual(output.matches, []);
});

test("SHS-11 propagates cancellation between candidate reads", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled by user");
  let metadataReads = 0;
  const pending = sessionHistorySearchToolEntry.handler(
    { query: "needle" },
    createContext(
      createStore({
        sessions: [createSession("sess_cancelled")],
        messages: async () => {
          controller.abort(reason);
          return [];
        },
        getSession: async () => {
          metadataReads += 1;
          return null;
        },
      }),
      { abortSignal: controller.signal },
    ),
  );

  await assert.rejects(pending, (error) => error === reason);
  assert.equal(metadataReads, 0);
});

test("SHS-12 registers the built-in tool exactly once", () => {
  assert.equal(
    builtInTools.filter((entry) => entry.metadata.name === SESSION_HISTORY_SEARCH_TOOL_NAME).length,
    1,
  );
  const registered: string[] = [];
  registerBuiltInTools({ register: (entry) => registered.push(entry.metadata.name) });
  assert.equal(registered.filter((name) => name === SESSION_HISTORY_SEARCH_TOOL_NAME).length, 1);
});
