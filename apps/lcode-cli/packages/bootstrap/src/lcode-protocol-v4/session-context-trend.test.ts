import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType } from "@lcode/contracts";
import { contextTrendSchema, mergeContextTrend } from "@lcode/shared/lcode-protocol-v4";
import { contextTrendFromPersistedMessages } from "./session-context-trend.js";
import { ProductProjection } from "./product-projection.js";
import { synthesizeEventsFromMessages } from "./transcript-hydration.js";

function assistant(id: string, timestamp: number, capacity?: number) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: "session",
      time: { created: timestamp - 1, completed: timestamp },
      providerId: "oauth:zed",
      modelId: id,
      tokens: { input: 100, output: 20, cache: { read: 60, write: 10 } },
      metadata: capacity ? { contextWindowTokens: capacity } : {},
    },
    parts: [],
  };
}
function complete(
  id: string,
  sequenceNumber: number,
  capacity?: number,
  sessionId = "session",
  querySource = "main_turn",
) {
  return {
    id: `event-${sequenceNumber}`,
    sessionId,
    traceId: "trace",
    sequenceNumber,
    timestamp: new Date(sequenceNumber * 100),
    type: SessionEventType.ModelComplete,
    payload: {
      querySource,
      stopReason: "end_turn",
      content: "",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
      contextWindow: capacity,
      contextSample: { assistantMessageId: id, providerId: "oauth:zed", modelId: id },
    },
  };
}

test("cold trend restores actual request and compact facts, historical capacity and excludes fork/synthetic history", () => {
  const inherited = assistant("fork", 400, 8000);
  inherited.info.metadata = { forkOrigin: { sessionId: "parent" } } as never;
  const synthetic = assistant("synthetic", 600, 1000);
  synthetic.info.tokens = { input: 0, output: 0, cache: { read: 0, write: 0 } };
  const samples = contextTrendFromPersistedMessages([
    assistant("old", 100),
    assistant("new", 200, 1000),
    inherited,
    synthetic,
    {
      info: { id: "summary", role: "user", time: { created: 300 }, summary: { title: "Compact" } },
      parts: [
        {
          type: "compaction",
          operationId: "operation",
          compactBoundary: {
            boundaryId: "boundary",
            preCompactTokenCount: 120,
            postCompactTokenCount: 80,
            truePostCompactTokenCount: 70,
          },
        },
      ],
    },
  ] as never);
  assert.deepEqual(
    samples.samples.map((sample) => [sample.id, sample.usedTokens, sample.maxTokens]),
    [
      ["request:old", 120, null],
      ["request:new", 120, 1000],
      ["compact:operation", 70, null],
    ],
  );
  assert.equal(samples.samples.at(-1)?.tokensBefore, 120);
  assert.equal(contextTrendSchema.safeParse(samples).success, true);
});

test("live samples isolate own session and sidecar, deduplicate stable request and retain model capacity changes", () => {
  const projection = new ProductProjection("session", "epoch");
  projection.applyEvent(complete("one", 1, 1000) as never);
  projection.applyEvent(complete("one", 2, 1000) as never);
  projection.applyEvent(complete("two", 3, 5000) as never);
  projection.applyEvent(complete("three", 4) as never);
  projection.applyEvent(complete("foreign", 5, 500, "other") as never);
  projection.applyEvent(complete("title", 6, 500, "session", "session_title") as never);
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.maxTokens),
    [1000, 5000, null],
  );
  const child = new ProductProjection("session", "epoch");
  child.applyEvent(complete("child", 1, 500, "session", "subagent") as never);
  assert.equal(child.getSnapshot().usage.contextTrend?.samples[0]?.usedTokens, 120);
});

test("compact marks a drop only on success and duplicate operation never adds another point", () => {
  const projection = new ProductProjection("session", "epoch");
  projection.applyEvent(complete("one", 1, 1000) as never);
  const compact = (sequenceNumber: number, status: string) => ({
    id: `compact-${sequenceNumber}`,
    sessionId: "session",
    traceId: "trace",
    sequenceNumber,
    timestamp: new Date(sequenceNumber * 100),
    type: SessionEventType.CompactCompleted,
    payload: {
      operationId: "op",
      messageId: "compact-message",
      status,
      trigger: "manual",
      display: "separator",
      preCompactTokenCount: 120,
      truePostCompactTokenCount: 30,
    },
  });
  projection.applyEvent(compact(2, "failed") as never);
  assert.equal(projection.getSnapshot().usage.contextTrend?.samples.length, 1);
  projection.applyEvent(compact(3, "completed") as never);
  projection.applyEvent(compact(4, "completed") as never);
  assert.deepEqual(
    projection
      .getSnapshot()
      .usage.contextTrend?.samples.map((sample) => [sample.kind, sample.usedTokens]),
    [
      ["request", 120],
      ["compact", 30],
    ],
  );
});

test("bounded samples survive cold seed and a late seed cannot replace live request facts", () => {
  const trend = contextTrendFromPersistedMessages(
    Array.from({ length: 205 }, (_, index) => assistant(String(index), index + 1, 1000)) as never,
  );
  assert.equal(trend.samples.length, 200);
  assert.equal(trend.truncated, true);
  assert.equal(trend.samples[0]?.id, "request:5");
  const projection = new ProductProjection("session", "epoch");
  projection.seedUsage({
    contextWindow: { usedTokens: 120, maxTokens: 1000, autoCompactThresholdTokens: null },
    contextTrend: trend,
  });
  projection.applyEvent(complete("live", 99, 2000) as never);
  projection.seedUsage({
    contextWindow: { usedTokens: 1, maxTokens: 1000, autoCompactThresholdTokens: null },
    contextTrend: { samples: [], truncated: false },
  });
  assert.equal(projection.getSnapshot().usage.contextTrend?.samples.at(-1)?.id, "request:live");
  assert.equal(projection.getSnapshot().usage.contextTrend?.truncated, true);
  assert.equal(mergeContextTrend(trend, trend.samples).samples.length, 200);
});

test("cold seed fills historical turns after replaying the current live turn and preserves its same-id fact", () => {
  const projection = new ProductProjection("session", "epoch");
  projection.applyEvent(complete("live", 5, 2000) as never);
  projection.seedUsage({
    contextWindow: { usedTokens: 120, maxTokens: 1000, autoCompactThresholdTokens: null },
    contextTrend: contextTrendFromPersistedMessages([
      assistant("history", 100, 1000),
      assistant("live", 400, 1000),
    ] as never),
  });
  const samples = projection.getSnapshot().usage.contextTrend?.samples;
  assert.deepEqual(
    samples?.map((sample) => [sample.id, sample.maxTokens]),
    [
      ["request:history", 1000],
      ["request:live", 2000],
    ],
  );
});

test("fork hydration keeps inherited compact markers without manufacturing child context samples", () => {
  const inherited = assistant("parent-assistant", 200, 1000);
  inherited.info.metadata = { forkOrigin: { sessionId: "parent" } } as never;
  const messages = [
    {
      info: {
        id: "parent-user",
        sessionID: "session",
        role: "user",
        time: { created: 100 },
        metadata: { forkOrigin: { sessionId: "parent" } },
      },
      parts: [
        {
          type: "text",
          id: "user-text",
          messageID: "parent-user",
          sessionID: "session",
          text: "inherited",
        },
      ],
    },
    {
      ...inherited,
      parts: [
        {
          type: "timeline",
          timelineType: "context_compaction",
          id: "compact-part",
          messageID: "parent-assistant",
          sessionID: "session",
          operationId: "parent-compact",
          display: "separator",
          trigger: "manual",
          status: "completed",
          postCompactTokenCount: 50,
          time: { start: 190, end: 200 },
        },
      ],
    },
  ] as never;
  const projection = new ProductProjection("session", "epoch");
  for (const event of synthesizeEventsFromMessages(messages, { sessionId: "session" }))
    projection.applyEvent(event);
  projection.seedUsage({
    contextWindow: { usedTokens: 50, maxTokens: 1000, autoCompactThresholdTokens: null },
    contextTrend: contextTrendFromPersistedMessages(messages),
  });
  assert.equal(projection.getSnapshot().usage.contextTrend?.samples.length, 0);
  assert.ok(
    projection
      .getSnapshot()
      .rows.window.some((row) => row.kind === "timelineMarker" && row.marker.type === "compact"),
  );
});

test("old-turn completions cannot enter the new turn trend and committed rewind removes abandoned samples", () => {
  const projection = new ProductProjection("session", "epoch");
  const start = (id: string, sequenceNumber: number) => ({
    id: `start-${id}`,
    sessionId: "session",
    traceId: "trace",
    turnId: id,
    sequenceNumber,
    timestamp: new Date(sequenceNumber * 100),
    type: SessionEventType.TurnStarted,
    payload: { turnNumber: sequenceNumber, messageId: `user-${id}`, input: "hello" },
  });
  projection.applyEvent(start("one", 1) as never);
  projection.applyEvent({ ...complete("one", 2, 1000), turnId: "one" } as never);
  projection.applyEvent(start("two", 3) as never);
  projection.applyEvent({ ...complete("late", 4, 1000), turnId: "one" } as never);
  projection.applyEvent({ ...complete("two", 5, 1000), turnId: "two" } as never);
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.id),
    ["request:one", "request:two"],
  );
  projection.applyEvent({
    id: "rewind",
    sessionId: "session",
    traceId: "trace",
    sequenceNumber: 6,
    timestamp: new Date(600),
    type: SessionEventType.RewindTriggered,
    payload: {
      scope: "conversation",
      targetMessageId: "user-two",
      branchGeneration: 1,
      branchCutAfterMessageId: "one",
    },
  } as never);
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.id),
    ["request:one"],
  );
  projection.applyEvent({ ...complete("two", 7, 1000), turnId: "two" } as never);
  projection.applyEvent({
    id: "late-compact",
    sessionId: "session",
    traceId: "trace",
    turnId: "two",
    sequenceNumber: 8,
    timestamp: new Date(800),
    type: SessionEventType.CompactCompleted,
    payload: {
      operationId: "late-compact",
      messageId: "compact-message",
      status: "completed",
      trigger: "manual",
      display: "separator",
      preCompactTokenCount: 120,
      truePostCompactTokenCount: 30,
    },
  } as never);
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.id),
    ["request:one"],
  );
  projection.seedUsage({
    contextWindow: { usedTokens: 120, maxTokens: 1000, autoCompactThresholdTokens: null },
    contextTrend: contextTrendFromPersistedMessages([assistant("abandoned", 500, 1000)] as never),
  });
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.id),
    ["request:one"],
  );
  projection.applyEvent(start("three", 9) as never);
  projection.applyEvent({ ...complete("three", 10, 2000), turnId: "three" } as never);
  assert.deepEqual(
    projection.getSnapshot().usage.contextTrend?.samples.map((sample) => sample.id),
    ["request:one", "request:three"],
  );
});
