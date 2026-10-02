import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePart, MessageWithParts, TokenUsageInfo } from "@lcode/contracts";
import {
  cloneModelInputMessage,
  createMessageHistory,
  createRuntimeAssistantEntry,
  invalidateRuntimeTokenUsage,
  systemReminderAttachmentEntry,
} from "./message-history.js";
import { hydrateMessageHistoryFromSession } from "./session-history-hydrator.js";

const tokens: TokenUsageInfo = {
  total: 15,
  input: 10,
  output: 5,
  reasoning: 0,
  cache: { read: 2, write: 1 },
};

function userMessage(
  id: string,
  parts: MessagePart[],
  extra: Record<string, unknown> = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "history-test",
      role: "user",
      time: { created: 1 },
      agent: "test",
      ...extra,
    },
    parts,
  } as MessageWithParts;
}

function textPart(id: string, text: string, extra: Record<string, unknown> = {}): MessagePart {
  return { id, type: "text", text, ...extra } as MessagePart;
}

test("history replacement clones input before commit and preserves the sole canonical snapshot", () => {
  const history = createMessageHistory();
  history.init([systemReminderAttachmentEntry("context_prefix", "context")]);
  const before = history.borrowReadOnlyRuntimeEntries();
  const assistant = createRuntimeAssistantEntry("answer", [], [], undefined, tokens);
  const replacement = history.prepareMessagesReplacement([assistant]);
  assistant.tokens!.cache.read = 99;
  assert.equal(history.borrowReadOnlyRuntimeEntries(), before);
  assert.equal(history.getCacheStats().cachedMessages, 1);
  replacement.commit();
  const committed = history.borrowReadOnlyRuntimeEntries()[0]!;
  assert.notEqual(history.borrowReadOnlyRuntimeEntries(), before);
  assert.ok(committed.kind !== "attachment");
  assert.equal(committed.tokens?.cache.read, 2);
  assert.equal(history.getCacheStats().cachedMessages, 0);
  const copy = history.toRuntimeEntries()[0]!;
  assert.ok(copy.kind !== "attachment");
  copy.message.content = "mutated copy";
  assert.equal(committed.message.content, "answer");
});

test("entry helpers preserve empty provider names, clone usage and retain callable arity", () => {
  const cloned = cloneModelInputMessage({
    role: "tool",
    toolName: "",
    content: "result",
    isError: false,
  });
  assert.equal(cloned.toolName, "");
  assert.equal(cloned.isError, false);
  const invalidated = invalidateRuntimeTokenUsage(tokens);
  assert.equal(invalidated.cache.read, 0);
  assert.equal(tokens.cache.read, 2);
  assert.equal(createRuntimeAssistantEntry.length, 5);
  assert.equal(createMessageHistory().addToolResult.length, 4);
});

test("hydration keeps pending shared context out and restores synthetic attachment provenance", async () => {
  const history = createMessageHistory();
  const result = await hydrateMessageHistoryFromSession({
    history,
    messages: [
      userMessage("pending", [textPart("p1", "not attached")], {
        source: "shared_context",
        metadata: { sharedContextStatus: "pending" },
      }),
      userMessage("notice", [
        textPart("p2", "queued notice", {
          synthetic: true,
          metadata: { source: "subagent" },
        }),
      ]),
      userMessage("background", [
        textPart("p3", "completed task", {
          synthetic: true,
          metadata: { source: "background_task" },
        }),
      ]),
      userMessage("user", [textPart("p4", "old text"), textPart("p4", "latest text")]),
    ],
  });
  assert.deepEqual(result, {
    appliedMessageCount: 3,
    interruptedToolCount: 0,
    messageCount: 4,
    partCount: 4,
  });
  const entries = history.toRuntimeEntries();
  assert.deepEqual(entries[0], {
    ...systemReminderAttachmentEntry("queued_system_notification", "queued notice"),
    cacheControl: undefined,
  });
  assert.ok(entries[1]?.kind !== "attachment");
  assert.equal(entries[1]?.metadata?.source, "legacy_synthetic");
  assert.equal(entries[1]?.message.content, "completed task");
  assert.ok(entries[2]?.kind !== "attachment");
  assert.equal(entries[2]?.message.content, "latest text");
});

test("hydration retains empty usage anchors and interrupted tool pairing", async () => {
  const history = createMessageHistory();
  const messages = [
    {
      info: { id: "usage", role: "assistant", tokens },
      parts: [],
    },
    {
      info: { id: "tool", role: "assistant" },
      parts: [
        {
          id: "tool-part",
          type: "tool",
          callID: "call",
          tool: "placeholder",
          metadata: { providerToolName: "" },
          state: { status: "running", input: {} },
        },
      ],
    },
  ] as unknown as MessageWithParts[];
  const result = await hydrateMessageHistoryFromSession({ history, messages });
  assert.equal(result.appliedMessageCount, 2);
  assert.equal(result.interruptedToolCount, 1);
  const entries = history.toRuntimeEntries();
  assert.equal(entries.length, 3);
  assert.ok(entries[1]?.kind !== "attachment");
  assert.equal(entries[1]?.message.toolCalls?.[0]?.name, "");
  assert.ok(entries[2]?.kind !== "attachment");
  assert.equal(entries[2]?.message.toolName, "");
  assert.equal(entries[2]?.message.isError, true);
});
