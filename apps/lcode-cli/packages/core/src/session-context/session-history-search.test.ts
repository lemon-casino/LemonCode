import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT,
  SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT,
  type AssistantMessageInfo,
  type MessageId,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type ProjectId,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type SessionTaskType,
  type TextPart,
  type UserMessageInfo,
} from "@lcode/contracts";
import {
  isSessionHistorySearchTaskType,
  projectSessionHistorySearchText,
  rankSessionHistorySearchCandidates,
  type SessionHistorySearchCandidate,
} from "./session-history-search.js";

const TEST_SESSION_ID = "sess_history" as SessionId;

test("only interactive roots and workflow parents are eligible search candidates", () => {
  for (const taskType of ["interactive", "fork", "workflow_parent"] as const) {
    assert.equal(isSessionHistorySearchTaskType(taskType), true, taskType);
  }
  for (const taskType of [
    "selection_side_chat",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
  ] as const) {
    assert.equal(isSessionHistorySearchTaskType(taskType), false, taskType);
  }
});

test("projection admits real and legacy user text while filtering non-searchable content", () => {
  const assistantId = messageId("assistant");
  const messages: MessageWithParts[] = [
    userMessage("real", "eligible real prompt", {
      semantics: visibleSemantics("real_user", "user_prompt"),
    }),
    userMessage("legacy", "eligible legacy prompt"),
    userMessage("legacy-source", "legacy sourced secret", {
      source: "background_task",
    }),
    userMessage("synthetic", "synthetic secret", { synthetic: true }),
    userMessage("model-only", "model only secret", { visibility: "model-only" }),
    userMessage("system-origin", "system origin secret", {
      semantics: visibleSemantics("system", "system_reminder"),
    }),
    assistantMessage(
      messageId("timeline-text"),
      [textPart(messageId("timeline-text"), "timeline control secret", "timeline-text")],
      {
        semantics: {
          kind: "timeline_event",
          origin: "system",
          providerVisibility: "hidden",
          transcriptVisibility: "visible",
          uiVisibility: "visible",
        },
      },
    ),
    assistantMessage(assistantId, [
      textPart(assistantId, "eligible assistant response", "assistant-text"),
      textPart(
        assistantId,
        "<system-reminder>system reminder secret</system-reminder>",
        "system-reminder",
      ),
      {
        id: partId("reasoning"),
        messageID: assistantId,
        sessionID: TEST_SESSION_ID,
        text: "reasoning secret",
        time: { start: 1 },
        type: "reasoning",
      },
      {
        callID: "call-secret",
        id: partId("tool"),
        messageID: assistantId,
        sessionID: TEST_SESSION_ID,
        state: {
          input: {},
          metadata: {},
          output: "tool output secret",
          status: "completed",
          time: { end: 2, start: 1 },
          title: "secret tool",
        },
        tool: "Read",
        type: "tool",
      },
    ]),
  ];

  const projection = projectSessionHistorySearchText({
    messages,
    session: session({ id: TEST_SESSION_ID }),
  });

  assert.equal(projection.activeMessageCount, messages.length);
  assert.match(projection.searchText, /eligible real prompt/u);
  assert.match(projection.searchText, /eligible legacy prompt/u);
  assert.match(projection.searchText, /eligible assistant response/u);
  for (const secret of [
    "legacy sourced secret",
    "synthetic secret",
    "model only secret",
    "system origin secret",
    "timeline control secret",
    "system reminder secret",
    "reasoning secret",
    "tool output secret",
  ]) {
    assert.doesNotMatch(projection.searchText, new RegExp(secret, "u"), secret);
  }
});

test("modern rewind projection excludes the discarded append-only branch", () => {
  const keptId = messageId("kept");
  const targetId = messageId("target");
  const cutId = messageId("discarded-tail");
  const replacementId = messageId("replacement");
  const revert: SessionRevert = {
    branchCutAfterMessageID: cutId,
    branchGeneration: 1,
    keptMessageIDs: [keptId],
    kind: "conversation_rewind",
    messageID: keptId,
    scope: "conversation",
    targetMessageID: targetId,
  };
  const projection = projectSessionHistorySearchText({
    messages: [
      userMessage(keptId, "kept branch fact"),
      userMessage(targetId, "discarded target match"),
      userMessage(cutId, "discarded tail match"),
      userMessage(replacementId, "active replacement fact"),
    ],
    session: session({ revert }),
  });

  assert.equal(projection.activeMessageCount, 2);
  assert.match(projection.searchText, /kept branch fact/u);
  assert.match(projection.searchText, /active replacement fact/u);
  assert.doesNotMatch(projection.searchText, /discarded target match/u);
  assert.doesNotMatch(projection.searchText, /discarded tail match/u);
});

test("ranking recognizes Chinese, camelCase, and snake_case queries", () => {
  const searchable = candidate({
    id: "sess_tokens",
    searchText: "User: 工作区记忆 stores workspaceIdentity beside workspace_identity",
  });

  for (const query of ["工作区记忆", "workspaceIdentity", "workspace_identity"]) {
    const ranked = rankSessionHistorySearchCandidates({ candidates: [searchable], query });
    assert.equal(ranked.length, 1, query);
    assert.equal(ranked[0]!.session.id, searchable.session.id, query);
    assert.ok(ranked[0]!.score > 0, query);
  }
});

test("title-only matches use and return at most the first 256 title characters", () => {
  const visibleTitle = `title-only-needle ${"v".repeat(400)}`;
  const hiddenAfterLimit = `${"x".repeat(SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT)} title-only-needle`;
  const ranked = rankSessionHistorySearchCandidates({
    candidates: [
      candidate({ id: "sess_hidden", searchText: "", title: hiddenAfterLimit }),
      candidate({ id: "sess_visible", searchText: "", title: visibleTitle }),
    ],
    query: "title-only-needle",
  });

  assert.deepEqual(
    ranked.map((result) => result.session.id),
    ["sess_visible"],
  );
  assert.equal(ranked[0]!.preview, "");
  assert.equal(ranked[0]!.title.length, SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT);
  assert.equal(
    ranked[0]!.title,
    visibleTitle.slice(0, SESSION_HISTORY_SEARCH_TITLE_CHARACTER_LIMIT),
  );
});

test("projection enforces the 32k per-session character budget", () => {
  const projection = projectSessionHistorySearchText({
    messages: [
      userMessage("large", "x".repeat(SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT + 4_096)),
    ],
    session: session(),
  });

  assert.equal(projection.truncated, true);
  assert.equal(projection.projectedCharacterCount, projection.searchText.length);
  assert.ok(projection.searchText.length <= SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT);
  assert.ok(projection.searchText.length > SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT - 32);
  assert.match(projection.searchText, /\.\.\.\[truncated\]$/u);
});

test("non-finite projection limits safely fall back to the bounded default", () => {
  const messages = [
    userMessage("large", "y".repeat(SESSION_HISTORY_SEARCH_SESSION_CHARACTER_LIMIT + 1_024)),
  ];
  const expected = projectSessionHistorySearchText({ messages, session: session() });

  for (const characterLimit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(
      projectSessionHistorySearchText({ characterLimit, messages, session: session() }),
      expected,
      String(characterLimit),
    );
  }
});

test("query-centered previews retain the match within the 1200 character cap", () => {
  const longSearchText = `${"prefix ".repeat(400)}preview-needle${" suffix".repeat(400)}`;
  const ranked = rankSessionHistorySearchCandidates({
    candidates: [candidate({ id: "sess_preview", searchText: longSearchText })],
    query: "preview-needle",
  });

  assert.equal(ranked.length, 1);
  assert.ok(ranked[0]!.preview.length <= SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT);
  assert.ok(ranked[0]!.preview.length > SESSION_HISTORY_SEARCH_PREVIEW_CHARACTER_LIMIT - 32);
  assert.equal(ranked[0]!.previewTruncated, true);
  assert.match(ranked[0]!.preview, /^\.\.\./u);
  assert.match(ranked[0]!.preview, /preview-needle/u);
});

test("equal candidates use ordinal session id ordering for punctuation", () => {
  const ranked = rankSessionHistorySearchCandidates({
    candidates: ["sess_a", "sess.a", "sess-a"].map((id) =>
      candidate({ id, searchText: "User: ordinal needle", updated: 10 }),
    ),
    query: "ordinal needle",
  });

  assert.deepEqual(
    ranked.map((result) => String(result.session.id)),
    ["sess-a", "sess.a", "sess_a"],
  );
});

function candidate(input: {
  id: string;
  searchText: string;
  title?: string;
  updated?: number;
}): SessionHistorySearchCandidate {
  return {
    projection: {
      activeMessageCount: input.searchText ? 1 : 0,
      projectedCharacterCount: input.searchText.length,
      searchText: input.searchText,
      truncated: false,
    },
    session: session({
      id: input.id as SessionId,
      title: input.title ?? "Unrelated title",
      updated: input.updated,
    }),
  };
}

function session(
  input: {
    id?: SessionId;
    revert?: SessionRevert;
    taskType?: SessionTaskType;
    title?: string;
    updated?: number;
  } = {},
): SessionInfo {
  return {
    directory: "/workspace",
    id: input.id ?? TEST_SESSION_ID,
    projectID: "project-history" as ProjectId,
    ...(input.revert ? { revert: input.revert } : {}),
    slug: "history",
    taskType: input.taskType ?? "interactive",
    time: { created: 1, updated: input.updated ?? 1 },
    title: input.title ?? "History session",
    version: "1",
  };
}

function userMessage(
  id: string | MessageId,
  text: string,
  overrides: Partial<UserMessageInfo> = {},
): MessageWithParts {
  const currentMessageId = typeof id === "string" ? (id as MessageId) : id;
  return {
    info: {
      ...overrides,
      agent: "build",
      id: currentMessageId,
      role: "user",
      sessionID: TEST_SESSION_ID,
      time: { created: 1 },
    },
    parts: [textPart(currentMessageId, text, String(currentMessageId))],
  };
}

function assistantMessage(
  messageID: MessageId,
  parts: MessagePart[],
  overrides: Partial<AssistantMessageInfo> = {},
): MessageWithParts {
  const info: AssistantMessageInfo = {
    ...overrides,
    agent: "build",
    cost: 0,
    id: messageID,
    mode: "build",
    parentID: messageId("parent"),
    path: { cwd: "/workspace", root: "/workspace" },
    role: "assistant",
    sessionID: TEST_SESSION_ID,
    time: { created: 1 },
    tokens: {
      cache: { read: 0, write: 0 },
      input: 0,
      output: 0,
      reasoning: 0,
    },
  };
  return { info, parts };
}

function textPart(messageID: MessageId, text: string, suffix: string): TextPart {
  return {
    id: partId(suffix),
    messageID,
    sessionID: TEST_SESSION_ID,
    text,
    type: "text",
  };
}

function visibleSemantics(
  origin: "real_user" | "system",
  kind: "system_reminder" | "user_prompt",
): NonNullable<UserMessageInfo["semantics"]> {
  return {
    kind,
    origin,
    providerVisibility: "visible",
    transcriptVisibility: "visible",
    uiVisibility: "visible",
  };
}

function messageId(value: string): MessageId {
  return `msg_${value}` as MessageId;
}

function partId(value: string): PartId {
  return `part_${value}` as PartId;
}
