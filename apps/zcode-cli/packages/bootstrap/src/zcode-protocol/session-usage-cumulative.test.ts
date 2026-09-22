import assert from "node:assert/strict";
import test from "node:test";
import { cumulativeFromPersistedMessages } from "./session-usage-cumulative.js";
import { ProductProjection } from "../zcode-protocol-v4/product-projection.js";
import { SessionEventType } from "@zcode/contracts";

test("child model completions count their own usage, not foreign or sidecar events", () => {
  const projection = new ProductProjection("child-one", "epoch-one");
  const event = (sessionId: string, querySource: string, sequenceNumber: number) => ({
    id: `event-${sequenceNumber}`,
    sessionId,
    type: SessionEventType.ModelComplete,
    timestamp: new Date(),
    traceId: "trace-one",
    sequenceNumber,
    payload: {
      querySource,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5 },
    },
  });
  projection.applyEvent(event("child-one", "subagent", 1) as never);
  projection.applyEvent(event("child-one", "workflow_child", 2) as never);
  projection.applyEvent(event("parent", "subagent", 3) as never);
  projection.applyEvent(event("child-one", "session_title", 4) as never);
  assert.deepEqual(projection.getSnapshot().usage.cumulative, {
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 120,
    cacheWriteTokens: 10,
  });
  assert.equal(projection.getSnapshot().usage.contextWindow?.usedTokens ?? 0, 0);
});

test("cold seed restores completed local model requests without recounting caches or fork history", () => {
  const messages = [
    { info: { role: "user" } },
    {
      info: {
        role: "assistant",
        time: { completed: 123 },
        tokens: { input: 100, output: 20, cache: { read: 80, write: 10 } },
      },
    },
    {
      info: {
        role: "assistant",
        time: { completed: 456 },
        tokens: { input: 150, output: 30, cache: { read: 120, write: 0 } },
      },
    },
    {
      info: {
        role: "assistant",
        time: { completed: 20 },
        tokens: { input: 200, output: 40, cache: { read: 0, write: 0 } },
        metadata: { forkOrigin: { sessionId: "parent" } },
      },
    },
    {
      info: {
        role: "assistant",
        summary: true,
        time: { completed: 789 },
        tokens: { input: 500, output: 50, cache: { read: 0, write: 0 } },
      },
    },
  ] as never;
  assert.deepEqual(cumulativeFromPersistedMessages(messages), {
    inputTokens: 250,
    outputTokens: 50,
    cacheReadTokens: 200,
    cacheWriteTokens: 10,
  });
});

test("cold seed reports no recovered usage for empty or only synthetic records", () => {
  assert.equal(cumulativeFromPersistedMessages([]), null);
  assert.equal(
    cumulativeFromPersistedMessages([
      {
        info: {
          role: "assistant",
          time: { completed: 200 },
          tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    ] as never),
    null,
  );
});

test("cold usage seed restores cumulative without overwriting later live usage", () => {
  const projection = new ProductProjection("session-one", "epoch-one");
  projection.seedUsage({
    contextWindow: { usedTokens: 40, maxTokens: 100, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 },
  });
  assert.equal(projection.getSnapshot().usage.cumulative.inputTokens, 100);
  projection.seedUsage({
    contextWindow: { usedTokens: 20, maxTokens: 100, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 1, outputTokens: 1 },
  });
  assert.equal(projection.getSnapshot().usage.cumulative.inputTokens, 100);
});

test("child cold seed can restore usage without a context watermark and cannot replace live usage", () => {
  const projection = new ProductProjection("child-one", "epoch-one");
  const seed = {
    contextWindow: { usedTokens: 0, maxTokens: null, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 250, outputTokens: 40 },
  };
  projection.seedUsage(seed);
  assert.equal(projection.getSnapshot().usage.cumulative.inputTokens, 250);
  assert.equal(projection.getSnapshot().usage.contextWindow, null);
  projection.applyEvent({
    id: "event-next", sessionId: "child-one", type: SessionEventType.ModelComplete,
    timestamp: new Date(), traceId: "trace-one", sequenceNumber: 1,
    payload: { querySource: "subagent", usage: { inputTokens: 70, outputTokens: 15 } },
  } as never);
  projection.seedUsage({
    contextWindow: { usedTokens: 100, maxTokens: 500, autoCompactThresholdTokens: null },
    cumulative: { inputTokens: 1, outputTokens: 1 },
  });
  assert.equal(projection.getSnapshot().usage.cumulative.inputTokens, 320);
  assert.equal(projection.getSnapshot().usage.cumulative.outputTokens, 55);
});
