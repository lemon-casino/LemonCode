import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateChildSessionUsage,
  collectChildSessionIds,
  readChildSessionTokenTotal,
  readSessionTokenTotal,
  readStreamingOutputSample,
  recordStreamingOutputSample,
  readStreamingOutputRate,
  retainObservedOutputRate,
} from "./sessionTokenStats.js";

test("child ids include only dispatched workflow actors, dedupe standard children and revisions", () => {
  const snapshot = {
    subagents: { childSessionIds: ["child-a", "child-a"] },
    workflowRuns: {
      runs: [
        {
          actors: [
            { siteId: "one", ordinal: 0, sessionId: "child-a" },
            { siteId: "two", ordinal: 0, sessionId: "unstarted" },
            { siteId: "three", ordinal: 1, sessionId: "child-b" },
          ],
          nodes: [
            { actorSiteId: "one", actorOrdinal: 0, phase: "settled" },
            { actorSiteId: "two", actorOrdinal: 0, phase: "queued" },
            { actorSiteId: "three", actorOrdinal: 1, phase: "executing" },
          ],
        },
        {
          actors: [{ siteId: "three", ordinal: 1, sessionId: "child-b" }],
          nodes: [{ actorSiteId: "three", actorOrdinal: 1, phase: "settled" }],
        },
      ],
    },
  } as never;
  assert.deepEqual(collectChildSessionIds(snapshot, "parent"), ["child-a", "child-b"]);
  assert.deepEqual(collectChildSessionIds(snapshot, "child-a"), ["child-b"]);
  assert.deepEqual(collectChildSessionIds(null, "parent"), []);
});

test("child cumulative sums distinct sessions, not context watermark or inherited run usage", () => {
  const known = {
    usage: {
      contextWindow: { usedTokens: 9000 },
      cumulative: { inputTokens: 150, outputTokens: 50 },
    },
  } as never;
  assert.deepEqual(aggregateChildSessionUsage([known, known]), {
    inputTokens: 300,
    outputTokens: 100,
    unknownCount: 0,
  });
  assert.deepEqual(
    aggregateChildSessionUsage([
      known,
      null,
      {
        usage: {
          contextWindow: { usedTokens: 9000 },
          cumulative: { inputTokens: 0, outputTokens: 0 },
        },
      } as never,
    ]),
    { inputTokens: 150, outputTokens: 50, unknownCount: 2 },
  );
});

test("a child with a completed answer and no recorded usage is unknown, not zero", () => {
  const withoutUsage = {
    control: { phase: "completedSuccess" },
    rows: {
      window: [{ kind: "assistantText", state: "complete", text: "done" }],
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0 },
    },
  };
  assert.equal(readChildSessionTokenTotal(withoutUsage as never), null);
  assert.deepEqual(aggregateChildSessionUsage([withoutUsage as never]), {
    inputTokens: 0,
    outputTokens: 0,
    unknownCount: 1,
  });
  const pending = {
    ...withoutUsage,
    rows: { window: [{ kind: "assistantText", state: "streaming", text: "working" }] },
  };
  assert.equal(readChildSessionTokenTotal(pending as never), 0);
  const settled = {
    ...withoutUsage,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 100, outputTokens: 20 },
    },
  };
  assert.equal(readChildSessionTokenTotal(settled as never), 120);
});

test("cumulative total counts input and output exactly once, not cache subsets", () => {
  assert.equal(
    readSessionTokenTotal({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
    }),
    1500,
  );
  assert.equal(readSessionTokenTotal(null), null);
  assert.equal(
    readSessionTokenTotal(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      20,
    ),
    null,
  );
  assert.equal(
    readSessionTokenTotal({
      inputTokens: Number.NaN,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    null,
  );
});

test("stream sample follows one response through reasoning and text, not previous responses", () => {
  const rows = [
    { kind: "assistantText", assistantResponseId: "old", text: "earlier", state: "complete" },
    { kind: "reasoning", assistantResponseId: "current", text: "思考中", state: "complete" },
    {
      kind: "assistantText",
      assistantResponseId: "current",
      text: "some reply",
      state: "streaming",
    },
  ] as never;
  const sample = readStreamingOutputSample(rows);
  assert.equal(sample?.responseId, "current");
  assert.ok((sample?.estimatedTokens ?? 0) > 3);
  assert.equal(
    readStreamingOutputSample([
      ...rows,
      { kind: "toolCall", assistantResponseId: "current", status: "running" },
    ] as never),
    null,
  );
  assert.equal(
    readStreamingOutputSample([
      { kind: "reasoning", assistantResponseId: "current", text: "思考中", state: "streaming" },
      { kind: "timelineMarker" },
    ] as never)?.responseId,
    "current",
  );
  assert.equal(
    readStreamingOutputSample([
      { kind: "assistantText", assistantResponseId: "current", text: "done", state: "complete" },
    ] as never),
    null,
  );
});

test("observed output rate remains visible during a running turn until a new measurement", () => {
  assert.equal(retainObservedOutputRate(null, null), null);
  assert.equal(retainObservedOutputRate(null, 0), null);
  assert.equal(retainObservedOutputRate(null, 20), 20);
  assert.equal(retainObservedOutputRate(20, null), 20);
  assert.equal(retainObservedOutputRate(20, 0), 20);
  assert.equal(retainObservedOutputRate(20, 12), 12);

  let tracker = recordStreamingOutputSample(null, { responseId: "a", estimatedTokens: 1 }, 1000);
  tracker = recordStreamingOutputSample(tracker, { responseId: "a", estimatedTokens: 13 }, 1600);
  const observed = readStreamingOutputRate(tracker, 1600);
  assert.equal(observed, 20);
  assert.equal(retainObservedOutputRate(observed, readStreamingOutputRate(tracker, 5000)), 20);
  tracker = recordStreamingOutputSample(tracker, { responseId: "b", estimatedTokens: 1 }, 5100);
  assert.equal(retainObservedOutputRate(observed, readStreamingOutputRate(tracker, 5100)), 20);
});

test("rolling output measurements expire without fresh tokens and reset for the next response", () => {
  assert.equal(readStreamingOutputRate(null, 1000), null);
  let tracker = recordStreamingOutputSample(null, { responseId: "a", estimatedTokens: 1 }, 1000);
  assert.equal(readStreamingOutputRate(tracker, 1000), null);
  tracker = recordStreamingOutputSample(tracker, { responseId: "a", estimatedTokens: 13 }, 1600);
  assert.equal(readStreamingOutputRate(tracker, 1600), 20);
  assert.equal(readStreamingOutputRate(tracker, 1800), 20);
  assert.equal(readStreamingOutputRate(tracker, 3200), null);
  tracker = recordStreamingOutputSample(tracker, { responseId: "a", estimatedTokens: 25 }, 3500);
  assert.ok((readStreamingOutputRate(tracker, 3600) ?? 0) > 0);
  tracker = recordStreamingOutputSample(tracker, { responseId: "b", estimatedTokens: 2 }, 3700);
  assert.equal(readStreamingOutputRate(tracker, 3700), null);
  tracker = recordStreamingOutputSample(tracker, { responseId: "b", estimatedTokens: 12 }, 4200);
  assert.equal(readStreamingOutputRate(tracker, 4300), 20);
});
