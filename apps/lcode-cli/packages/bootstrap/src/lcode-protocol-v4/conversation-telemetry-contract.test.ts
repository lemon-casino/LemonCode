import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import {
  ConversationTelemetryFactNormalizer,
  streamingParentToolCallId,
} from "./conversation-telemetry-facts.js";

function event(type: SessionEvent["type"], payload: unknown, sequenceNumber = 1): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: "session-one",
    traceId: "trace-one",
    turnId: "turn-one",
    timestamp: new Date(1_000),
    sequenceNumber,
    type,
    payload,
  } as SessionEvent;
}

const network = (requestId: string, querySource = "main_turn") =>
  event(SessionEventType.ModelNetworkStatus, {
    type: "model_request_completed",
    requestId,
    querySource,
    providerId: "provider-one",
    modelId: "model-one",
    providerKind: "fixture",
    baseURL: "https://example.com/api",
    transport: "http",
    attempt: 1,
    maxAttempts: 3,
    durationMs: 25,
  });
const complete = (querySource = "main_turn") =>
  event(SessionEventType.ModelComplete, {
    querySource,
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 },
  });

test("telemetry request identity remains FIFO and isolated by session and query source", () => {
  const normalizer = new ConversationTelemetryFactNormalizer();
  normalizer.normalize(
    "session-one",
    event(SessionEventType.TurnStarted, { inputId: "command-one" }),
  );
  normalizer.normalize("session-one", network("main-first"));
  normalizer.normalize("session-one", network("child-first", "workflow_child"));
  normalizer.normalize("session-one", network("main-second"));
  normalizer.normalize("session-two", network("other-session"));
  for (const [sessionId, source, expected] of [
    ["session-one", "main_turn", "main-first"],
    ["session-one", "workflow_child", "child-first"],
    ["session-one", "main_turn", "main-second"],
    ["session-two", "main_turn", "other-session"],
  ]) {
    const fact = normalizer.normalize(sessionId!, complete(source));
    assert.ok(fact?.kind === "usage.delta");
    assert.equal(fact.requestId, expected);
    assert.equal(fact.providerHostname, "example.com");
    assert.equal(fact.sourceCommandId, sessionId === "session-one" ? "command-one" : undefined);
    assert.equal(fact.inputTokens, 10);
    assert.equal(fact.outputTokens, 5);
  }
  assert.equal(normalizer.normalize("session-one", complete("title")), null);
  normalizer.normalize("session-one", network("cleared"));
  normalizer.clearSession("session-one");
  const afterClear = normalizer.normalize("session-one", complete());
  assert.ok(afterClear?.kind === "usage.delta");
  assert.equal(afterClear.requestId, undefined);
  assert.equal(afterClear.sourceCommandId, undefined);
});

test("stream first-chunk tracking is per parent and clears with terminal turn", () => {
  const normalizer = new ConversationTelemetryFactNormalizer();
  const stream = (parent: string) =>
    event(SessionEventType.ModelStreaming, {
      kind: "text_delta",
      delta: "hello",
      partId: "part-one",
      _meta: { lcode: { parentToolUseId: parent } },
    });
  for (const [parent, expected] of [
    ["parent-one", true],
    ["parent-one", false],
    ["parent-two", true],
  ] as const) {
    const fact = normalizer.normalize("session-one", stream(parent));
    assert.ok(fact?.kind === "stream.chunk");
    assert.equal(fact.firstChunk, expected);
    assert.equal(fact.parentToolCallId, parent);
  }
  normalizer.normalize(
    "session-one",
    event(SessionEventType.TurnComplete, {
      resultType: "success",
      duration: 10,
      tokenCount: 2,
      toolCallCount: 0,
    }),
  );
  const fresh = normalizer.normalize("session-one", stream("parent-one"));
  assert.ok(fresh?.kind === "stream.chunk");
  assert.equal(fresh.firstChunk, true);
  assert.equal(
    streamingParentToolCallId({ parentToolCallId: "direct", _meta: { parentToolUseId: "nested" } }),
    "direct",
  );
  assert.equal(ConversationTelemetryFactNormalizer.prototype.normalize.length, 3);
  assert.equal(ConversationTelemetryFactNormalizer.prototype.clearSession.length, 1);
  assert.equal(streamingParentToolCallId.length, 1);
});

test("tool terminal fact keeps mirrored identity and only whitelisted performance fields", () => {
  const normalizer = new ConversationTelemetryFactNormalizer();
  normalizer.normalize(
    "session-one",
    event(SessionEventType.ToolCallScheduled, {
      toolCallId: "tool-one",
      toolName: "Skill",
    }),
  );
  const fact = normalizer.normalize(
    "session-one",
    event(SessionEventType.ToolCallResult, {
      toolCallId: "tool-one",
      duration: 12,
      parentToolCallId: "parent",
      childToolCallId: "child",
      agentId: "agent",
      childSessionId: "session-child",
      background: true,
      skillMetadata: { qualifiedName: "fixture:skill", pluginId: "fixture", source: "plugin" },
      result: {
        success: true,
        perf: {
          totalMs: 12,
          detail: {
            kind: "command",
            command: {
              runMs: 10,
              exitCode: 0,
              hash: "0123456789abcdef",
            },
          },
        },
      },
    }),
  );
  assert.ok(fact?.kind === "tool.lifecycle");
  assert.equal(fact.toolName, "Skill");
  assert.equal(fact.parentToolCallId, "parent");
  assert.equal(fact.skillQualifiedName, "fixture:skill");
  assert.deepEqual(fact.performance, { totalMs: 12, commandRunMs: 10, exitCode: 0 });
});
