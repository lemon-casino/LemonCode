import assert from "node:assert/strict";
import test from "node:test";
import { CompactTrigger, createMessageId, SessionEventType } from "../deps.js";
import type { CompactBoundaryPayload, ModelStreamEvent, SessionEvent } from "../deps.js";
import { compactActiveConversation } from "./compact-active.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";

test("compact commits summary and boundary before replacing canonical history", async () => {
  const { runtime, model, storedEvents } = createMockRuntime();
  runtime.messageHistory.addUser("original question");
  runtime.messageHistory.addAssistant("original answer");
  runtime.latestConversationMessageId = createMessageId();
  const original = JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  const order: string[] = [];
  const append = runtime.appendEvent;
  runtime.appendEvent = async function (event, trace) {
    order.push(event.type);
    if (event.type === SessionEventType.CompactBoundary) {
      assert.equal(JSON.stringify(this.messageHistory.borrowReadOnlyRuntimeEntries()), original);
    }
    await append.call(this, event, trace);
  };
  runtime.persistCompactSummary = async function (_id, _content, _summary, boundary) {
    order.push("summary");
    assert.equal(JSON.stringify(this.messageHistory.borrowReadOnlyRuntimeEntries()), original);
    assert.equal(boundary.lastSummarizedMessageId, this.latestConversationMessageId);
  };
  const result = await compactActiveConversation.call(
    runtime,
    undefined,
    runtime.rootTraceContext,
    [],
    { model },
  );
  assert.equal(result.outcome, "compacted");
  assert.ok(order.indexOf("summary") < order.indexOf(SessionEventType.CompactBoundary));
  assert.ok(
    order.indexOf(SessionEventType.CompactBoundary) <
      order.indexOf(SessionEventType.CompactCompleted),
  );
  assert.match(
    JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries()),
    /Mock result/,
  );
  const boundaryEvent = storedEvents.find(
    (event) => event.type === SessionEventType.CompactBoundary,
  );
  assert.ok(boundaryEvent);
  const boundary = boundaryEvent.payload as CompactBoundaryPayload;
  assert.equal(runtime.latestConversationMessageId, boundary.summaryMessageIds[0]);
});

test("automatic compact retries from the original selection without publishing a failed timeline", async () => {
  let calls = 0;
  const requests: string[] = [];
  const { runtime, model, storedEvents } = createMockRuntime({}, async function* () {
    calls += 1;
    yield { type: "text_start", id: "summary" } satisfies ModelStreamEvent;
    yield { type: "text_delta", id: "summary", text: "Mock summary" } satisfies ModelStreamEvent;
    yield { type: "text_end", id: "summary" } satisfies ModelStreamEvent;
    if (calls === 1) throw new Error("committed mock stream failed");
    yield { type: "finish", finishReason: "stop", usage: {} } satisfies ModelStreamEvent;
  });
  runtime.messageHistory.addUser("old question");
  runtime.messageHistory.addAssistant("old answer");
  runtime.messageHistory.addUser("new question");
  runtime.messageHistory.addAssistant("new answer");
  const append = runtime.appendEvent;
  runtime.appendEvent = async function (event: SessionEvent, trace) {
    if (event.type === SessionEventType.ModelRequest) {
      requests.push(JSON.stringify((event.payload as { messages: unknown }).messages));
    }
    await append.call(this, event, trace);
  };
  const result = await compactActiveConversation.call(
    runtime,
    undefined,
    runtime.rootTraceContext,
    [],
    {
      model,
      trigger: CompactTrigger.Auto,
    },
  );
  assert.equal(result.outcome, "compacted");
  assert.equal(calls, 2);
  assert.equal(requests[0], requests[1]);
  assert.ok(!storedEvents.some((event) => event.type === SessionEventType.CompactFailed));
  const started = storedEvents.filter((event) => event.type === SessionEventType.CompactStarted);
  assert.equal(started.length, 2);
  const retryEvent = started[1];
  assert.ok(retryEvent);
  assert.equal((retryEvent.payload as { status: string }).status, "retrying");
});

test("compact failure preserves a falsy primary error and never replaces history", async () => {
  const { runtime, model } = createMockRuntime();
  runtime.messageHistory.addUser("question");
  runtime.messageHistory.addAssistant("answer");
  const original = JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  runtime.persistCompactSummary = async () => {
    throw 0;
  };
  await assert.rejects(
    compactActiveConversation.call(runtime, undefined, runtime.rootTraceContext, [], { model }),
    (error) => error === 0,
  );
  assert.equal(JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries()), original);
});
