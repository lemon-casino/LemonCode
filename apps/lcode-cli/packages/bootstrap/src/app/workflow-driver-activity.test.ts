import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type SessionEvent,
  type SessionId,
} from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";
import type { AskActivity, AskWaitInfo, InstanceRef } from "@lcode/dynamic-workflow";
import { createActorModelActivity } from "./workflow-driver-concurrency.js";

const EPOCH = 1_700_000_000_000;

class FakeClock {
  time = EPOCH;
  timers = new Map<() => void, number>();
  callbacks: Array<() => void> = [];
  now = () => this.time;
  schedule = (callback: () => void, delayMs: number) => {
    this.timers.set(callback, this.time + delayMs);
    this.callbacks.push(callback);
    return () => {
      this.timers.delete(callback);
    };
  };
  advance(ms: number) {
    this.time += ms;
    for (const [callback, due] of this.timers) {
      if (due > this.time) continue;
      this.timers.delete(callback);
      callback();
    }
  }
}

function harness() {
  const clock = new FakeClock();
  const sessionId = "activity-session" as SessionId;
  let instance: InstanceRef | undefined = { siteId: "ask#1", ordinal: 1 };
  let turnId = "turn-1";
  let seq = 0;
  const listeners = new Set<(event: SessionEvent) => void>();
  const output: Array<{ instance: InstanceRef; activity: AskActivity }> = [];
  const waits: AskWaitInfo[] = [];
  let executing = 0;
  let mutating = 0;
  let completed = 0;
  const runtime = {
    subscribeEvents: ({ onSessionEvent }: { onSessionEvent: (event: SessionEvent) => void }) => {
      listeners.add(onSessionEvent);
      return () => {
        listeners.delete(onSessionEvent);
      };
    },
  } as unknown as AgentRuntime;
  const observer = createActorModelActivity({
    port: undefined,
    runId: "activity-run",
    live: () => instance,
    clock,
    handlers: {
      onActivity: (owner, activity) => output.push({ instance: owner, activity }),
      onWaiting: (info) => waits.push(info),
      onExecuting: () => {
        executing++;
      },
      onMutating: () => {
        mutating++;
      },
      onRequestCompleted: () => {
        completed++;
      },
    },
  });
  const emit = (type: SessionEvent["type"], payload: unknown, at = clock.time, turn = turnId) => {
    const event = {
      type,
      payload,
      timestamp: new Date(at),
      turnId: turn,
      sessionId,
      id: `event-${++seq}`,
      sequenceNumber: seq,
      traceId: "trace-1",
    } as SessionEvent;
    for (const listener of listeners) listener(event);
    return event;
  };
  const network = (
    type: ModelNetworkStatusEvent["type"],
    requestId: string,
    extra: Record<string, unknown> = {},
    at = clock.time,
    turn = turnId,
  ) => {
    emit(
      SessionEventType.ModelNetworkStatus,
      {
        type,
        requestId,
        querySource: "workflow_child",
        queryId: "query-1",
        turnId: turn,
        timestamp: new Date(at).toISOString(),
        traceId: "trace-1",
        providerId: "provider",
        modelId: "model",
        transport: "stream",
        attempt: 1,
        maxAttempts: 0,
        ...extra,
      },
      at,
      turn,
    );
  };
  const stream = (kind: string, delta: string, at = clock.time, turn = turnId) => {
    emit(SessionEventType.ModelStreaming, { kind, delta, done: false }, at, turn);
  };
  const begin = (queryId = "query-1", turn = "turn-1") => {
    turnId = turn;
    observer.beginTurn(queryId);
    emit(SessionEventType.TurnStarted, { queryId, turnNumber: 1, input: "private input" });
  };
  observer.observe(runtime, sessionId);
  observer.reset();
  return {
    clock,
    output,
    waits,
    observer,
    emit,
    network,
    stream,
    begin,
    listeners,
    current: () => instance,
    setInstance: (next: InstanceRef | undefined) => {
      instance = next;
    },
    counts: () => ({ executing, mutating, completed }),
  };
}

test("hidden output stays model; only nonempty, correlated deltas establish reasoning or text", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "request-1");
  assert.deepEqual(h.output.at(-1)?.activity, {
    kind: "model",
    observedAt: EPOCH,
    since: EPOCH,
    requestId: "request-1",
    requestsCompleted: 0,
    toolCalls: 0,
  });
  h.clock.advance(30_000);
  assert.equal(h.output.length, 1, "silence must not manufacture heartbeats or reasoning");
  h.stream("reasoning_start", "");
  h.stream("reasoning_delta", "");
  h.stream("tool_input_delta", "private tool parameters");
  assert.equal(h.output.length, 1);
  h.stream("reasoning_delta", "private reasoning");
  assert.equal(h.output.at(-1)?.activity.kind, "reasoning");
  h.clock.advance(10);
  h.stream("text_delta", "private answer");
  assert.equal(h.output.at(-1)?.activity.kind, "text");
  assert.equal(h.output.at(-1)?.activity.since, EPOCH + 30_010);
  assert.equal(JSON.stringify(h.output).includes("private"), false);
  assert.deepEqual(h.observer.noteTurnResolved(), { turn: 1, toolCalls: 0 });
  h.observer.unsubscribe();
});

test("same-kind deltas coalesce at 1Hz with their source time; changes and completion publish immediately", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "request-1");
  h.stream("reasoning_delta", "first");
  const initial = h.output.length;
  for (let i = 1; i <= 99; i++) {
    h.clock.advance(10);
    h.stream("reasoning_delta", "next");
    assert.ok(h.clock.timers.size <= 1);
  }
  assert.equal(h.output.length, initial);
  h.clock.advance(10);
  assert.equal(h.output.length, initial + 1);
  assert.equal(h.output.at(-1)?.activity.observedAt, EPOCH + 990);
  assert.equal(h.output.at(-1)?.activity.since, EPOCH);
  assert.equal(h.clock.timers.size, 0);
  h.clock.advance(100);
  h.stream("reasoning_delta", "pending");
  assert.equal(h.clock.timers.size, 1);
  h.stream("text_delta", "answer");
  assert.equal(h.output.at(-1)?.activity.kind, "text");
  assert.equal(h.clock.timers.size, 0);
  h.clock.advance(10);
  h.stream("text_delta", "pending answer");
  h.network("model_request_completed", "request-1", { durationMs: 1_110 });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 1);
  assert.equal(h.output.at(-1)?.activity.lastRequestCompletedAt, EPOCH + 1_110);
  assert.equal(h.clock.timers.size, 0);
  const done = h.output.length;
  h.clock.advance(60_000);
  assert.equal(h.output.length, done);
  h.observer.unsubscribe();
});

test("source request timestamps survive delayed delivery and bounded identifiers exclude private metadata", () => {
  const h = harness();
  h.begin();
  h.clock.advance(5_000);
  h.network(
    "model_request_started",
    "r".repeat(400),
    { requestHeaders: { secret: "private" }, modelCall: { raw: "private" } },
    EPOCH + 10,
  );
  assert.equal(h.output.at(-1)?.activity.observedAt, EPOCH + 10);
  assert.equal(h.output.at(-1)?.activity.since, EPOCH + 10);
  assert.equal(h.output.at(-1)?.activity.requestId?.length, 256);
  h.emit(SessionEventType.ToolCallScheduled, {
    toolCallId: "tool-1",
    toolName: "t".repeat(100),
    input: { command: "private command" },
  });
  h.emit(
    SessionEventType.ToolCallStarted,
    {
      toolCallId: "tool-1",
      startedAt: new Date(EPOCH + 20),
      readOnly: true,
      sideEffectScope: "none",
    },
    EPOCH + 20,
  );
  assert.equal(h.output.at(-1)?.activity.toolName?.length, 64);
  assert.equal(h.output.at(-1)?.activity.observedAt, EPOCH + 20);
  assert.equal(h.output.at(-1)?.activity.since, EPOCH + 20);
  assert.equal(JSON.stringify(h.output).includes("private"), false);
  assert.equal(
    h.observer.lastTool()?.target,
    "private command",
    "existing progress target semantics are unchanged",
  );
  h.observer.unsubscribe();
});

test("physical request successes dedupe and an older completion cannot clear a newer request", () => {
  const h = harness();
  h.begin();
  h.network("model_request_completed", "unseen", { durationMs: 0 });
  assert.equal(h.output.length, 0);
  h.network("model_request_started", "old");
  h.clock.advance(10);
  h.network("model_request_started", "new");
  h.clock.advance(10);
  h.network("model_request_completed", "old", { durationMs: 20 });
  assert.equal(h.output.at(-1)?.activity.requestId, "new");
  assert.equal(h.output.at(-1)?.activity.kind, "model");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 1);
  const count = h.output.length;
  h.network("model_request_completed", "old", { durationMs: 20 });
  h.network("model_retry_scheduled", "old", {
    reason: "network_error",
    delayMs: 1_000,
    nextAttempt: 2,
  });
  h.network("model_request_started", "old");
  assert.equal(h.output.length, count);
  assert.deepEqual(h.waits, []);
  h.network("model_request_completed", "new", { durationMs: 10 });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 2);
  assert.equal(h.counts().completed, 2);
  assert.deepEqual(h.observer.noteTurnResolved(), { turn: 1, toolCalls: 0 });
  h.begin("query-2", "turn-2");
  h.network("model_request_started", "third", { queryId: "query-2" });
  h.network("model_request_completed", "third", { queryId: "query-2", durationMs: 0 });
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 3);
  assert.deepEqual(h.observer.noteTurnResolved(), { turn: 2, toolCalls: 0 });
  h.observer.unsubscribe();
});

test("parallel tools preserve remaining work and share tool counts and the mutating gate", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "main");
  h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "tool-1",
    toolName: "Read",
    readOnly: true,
    sideEffectScope: "none",
  });
  h.clock.advance(10);
  h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "tool-2",
    toolName: "Write",
    readOnly: false,
    sideEffectScope: "workspace",
  });
  h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "tool-2",
    toolName: "Write",
    readOnly: false,
    sideEffectScope: "workspace",
  });
  h.network("model_request_started", "sidecar", { querySource: "tool", toolCallId: "tool-1" });
  h.network("model_request_completed", "sidecar", {
    querySource: "tool",
    toolCallId: "tool-1",
    durationMs: 1,
  });
  assert.equal(h.output.at(-1)?.activity.kind, "tool");
  assert.equal(h.output.at(-1)?.activity.toolName, "Write");
  h.clock.advance(10);
  h.emit(SessionEventType.ToolCallError, {
    toolCallId: "tool-2",
    error: { message: "private error" },
  });
  assert.equal(h.output.at(-1)?.activity.toolName, "Read");
  assert.equal(h.output.at(-1)?.activity.since, EPOCH);
  h.network("model_request_completed", "main", { durationMs: 20 });
  assert.equal(h.output.at(-1)?.activity.kind, "tool");
  const settledOne = h.output.length;
  h.emit(SessionEventType.ToolCallResult, { toolCallId: "tool-2", result: "private" });
  assert.equal(h.output.length, settledOne);
  h.clock.advance(60_000);
  assert.equal(
    h.output.length,
    settledOne,
    "a long tool without events is not a stalled model or heartbeat",
  );
  h.emit(SessionEventType.ToolCallResult, { toolCallId: "tool-1", result: "private" });
  assert.deepEqual(h.output.at(-1)?.activity, {
    kind: "unknown",
    observedAt: EPOCH + 60_020,
    since: EPOCH + 60_020,
    requestsCompleted: 2,
    toolCalls: 2,
    lastRequestCompletedAt: EPOCH + 20,
  });
  assert.deepEqual(h.observer.toolCounts(), { toolCalls: 2, worldToolCalls: 2 });
  assert.equal(h.counts().mutating, 1);
  assert.deepEqual(h.waits, []);
  h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "submit",
    toolName: "submit_result",
    sideEffectScope: "session",
  });
  assert.deepEqual(h.observer.toolCounts(), { toolCalls: 3, worldToolCalls: 2 });
  h.observer.unsubscribe();
});

test("only an unambiguous main request in the matching turn can own an identity-less stream", () => {
  const h = harness();
  h.begin();
  h.stream("reasoning_delta", "not attached");
  assert.equal(h.output.length, 0);
  h.network("model_request_started", "tool-request", { querySource: "tool", toolCallId: "tool-1" });
  h.stream("reasoning_delta", "tool sidecar");
  assert.equal(h.output.at(-1)?.activity.kind, "model");
  h.network("model_request_completed", "tool-request", {
    querySource: "tool",
    toolCallId: "tool-1",
    durationMs: 0,
  });
  h.network("model_request_started", "main-a");
  h.stream("reasoning_delta", "wrong turn", h.clock.time, "old-turn");
  assert.equal(h.output.at(-1)?.activity.kind, "model");
  h.network("model_request_started", "main-b", { queryId: "overlapping-query" });
  h.stream("reasoning_delta", "ambiguous");
  assert.equal(h.output.at(-1)?.activity.kind, "model");
  h.network("model_request_completed", "main-a", { durationMs: 0 });
  h.stream("reasoning_delta", "known main");
  assert.equal(h.output.at(-1)?.activity.kind, "reasoning");
  assert.equal(h.output.at(-1)?.activity.requestId, "main-b");
  h.observer.unsubscribe();
});

test("retry facts are immediate, unsuccessful requests do not count and waiting aggregation is preserved", () => {
  const h = harness();
  h.begin();
  h.network("model_request_queued", "main");
  assert.deepEqual(h.waits, [{ cause: "slot" }]);
  h.network("model_request_admitted", "main", { queuedMs: 0 });
  h.network("model_request_started", "main");
  h.stream("reasoning_delta", "reasoning");
  h.clock.advance(10);
  h.stream("reasoning_delta", "pending");
  h.network("model_request_failed", "main", { retryable: true, reason: "network_error" });
  h.network("model_retry_scheduled", "main", {
    reason: "network_error",
    delayMs: 2_000,
    nextAttempt: 2,
  });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.waits.at(-1), {
    cause: "backoff",
    reason: "network_error",
    delayMs: 2_000,
    attempt: 2,
  });
  h.clock.advance(2_000);
  h.network("model_request_started", "retry", { attempt: 2 });
  assert.equal(h.counts().executing, 2);
  h.network("model_request_started", "other", { querySource: "tool", toolCallId: "other-tool" });
  h.network("model_request_queued", "waiting", { querySource: "tool", toolCallId: "waiting-tool" });
  const waitCount = h.waits.length;
  h.network("model_request_completed", "retry", { attempt: 2, durationMs: 0 });
  assert.equal(
    h.waits.length,
    waitCount,
    "one completing branch cannot clear another executing branch",
  );
  assert.equal(h.output.at(-1)?.activity.requestId, "other");
  h.network("model_request_completed", "other", {
    querySource: "tool",
    toolCallId: "other-tool",
    durationMs: 0,
  });
  assert.deepEqual(h.waits.at(-1), { cause: "slot" });
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 2);
  h.observer.unsubscribe();
});

test("reset, attempt changes, turn guards, terminal events and unsubscribe fence pending timers", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "old");
  h.stream("text_delta", "first");
  h.clock.advance(10);
  h.stream("text_delta", "pending");
  const staleTimer = h.clock.callbacks.at(-1)!;
  assert.equal(h.clock.timers.size, 1);
  h.setInstance({ siteId: "ask#1", ordinal: 1, attempt: 2 });
  h.observer.reset();
  assert.equal(h.clock.timers.size, 0);
  const afterReset = h.output.length;
  h.network("model_request_completed", "old", { durationMs: 10 });
  h.emit(SessionEventType.ToolCallStarted, { toolCallId: "stale-tool", toolName: "Write" });
  staleTimer();
  assert.equal(h.output.length, afterReset);
  assert.equal(h.counts().mutating, 0);
  h.begin("query-2", "turn-2");
  h.network("model_request_started", "new", { queryId: "query-2" });
  h.network("model_request_started", "late-old", {}, h.clock.time, "turn-1");
  h.stream("reasoning_delta", "late", h.clock.time, "turn-1");
  assert.equal(h.output.at(-1)?.activity.requestId, "new");
  assert.deepEqual(h.output.at(-1)?.instance, { siteId: "ask#1", ordinal: 1, attempt: 2 });
  h.stream("text_delta", "new text");
  h.clock.advance(10);
  h.stream("text_delta", "new pending");
  const pending = h.clock.callbacks.at(-1)!;
  staleTimer();
  assert.equal(h.clock.timers.size, 1, "old timer must not steal new pending state");
  h.emit(SessionEventType.TurnComplete, {});
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.clock.timers.size, 0);
  const completed = h.output.length;
  pending();
  h.network("model_request_started", "after-complete", { queryId: "query-2" });
  assert.equal(h.output.length, completed);
  h.begin("query-3", "turn-3");
  h.network("model_request_started", "third", { queryId: "query-3" });
  h.stream("text_delta", "third");
  h.clock.advance(10);
  h.stream("text_delta", "pending third");
  const releasedTimer = h.clock.callbacks.at(-1)!;
  h.observer.unsubscribe();
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  const released = h.output.length;
  releasedTimer();
  assert.equal(h.output.length, released);
});

test("ordinary tool progress is also bounded and replayed source sequences do not duplicate work", () => {
  const h = harness();
  h.begin();
  const started = h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "tool",
    toolName: "Read",
    readOnly: true,
  });
  for (const listener of h.listeners) listener(started);
  assert.equal(h.observer.toolCounts().toolCalls, 1);
  const initial = h.output.length;
  for (let i = 0; i < 20; i++) {
    h.clock.advance(10);
    h.emit(SessionEventType.ToolCallProgress, { toolCallId: "tool", outputPreview: "private" });
  }
  assert.equal(h.output.length, initial);
  h.clock.advance(800);
  assert.equal(h.output.length, initial + 1);
  assert.equal(h.output.at(-1)?.activity.observedAt, EPOCH + 200);
  assert.equal(JSON.stringify(h.output).includes("private"), false);
  h.observer.suspend();
  assert.equal(h.clock.timers.size, 0);
  h.observer.unsubscribe();
});

test("a superseded request never owns output but its observed late success is still counted", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "old");
  h.clock.advance(10);
  h.network("model_request_started", "new");
  h.stream("reasoning_delta", "new reasoning");
  assert.equal(h.output.at(-1)?.activity.kind, "reasoning");
  assert.equal(h.output.at(-1)?.activity.requestId, "new");
  h.network("model_request_completed", "new", { durationMs: 0 });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  h.stream("reasoning_delta", "unowned trailing output");
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  h.network("model_request_completed", "old", { durationMs: 10 });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 2);
  h.observer.unsubscribe();
});

test("a tool starting during backoff does not pretend that provider admission resumed", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "failed");
  h.network("model_request_failed", "failed", { reason: "network_error", retryable: true });
  h.network("model_retry_scheduled", "failed", {
    reason: "network_error",
    delayMs: 1_000,
    nextAttempt: 2,
  });
  h.emit(SessionEventType.ToolCallStarted, {
    toolCallId: "parallel-tool",
    toolName: "Read",
    readOnly: true,
  });
  assert.equal(h.output.at(-1)?.activity.kind, "tool");
  assert.equal(h.output.at(-1)?.activity.toolName, "Read");
  assert.equal(h.counts().executing, 1);
  assert.deepEqual(h.waits.at(-1), {
    cause: "backoff",
    reason: "network_error",
    delayMs: 1_000,
    attempt: 2,
  });
  h.clock.advance(1_000);
  h.network("model_request_started", "retry", { attempt: 2 });
  assert.equal(h.counts().executing, 2, "only the real provider restart clears waiting");
  h.network("model_request_completed", "retry", { attempt: 2, durationMs: 0 });
  assert.equal(h.output.at(-1)?.activity.kind, "tool");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 1);
  h.emit(SessionEventType.ToolCallResult, { toolCallId: "parallel-tool", result: "fixture" });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  h.observer.unsubscribe();
});

test("late failures of superseded physical requests cannot reappear after the current request completes", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "old");
  h.clock.advance(10);
  h.network("model_request_started", "new");
  h.network("model_request_failed", "old", { reason: "timeout", retryable: true });
  assert.equal(h.output.at(-1)?.activity.requestId, "new");
  h.network("model_retry_scheduled", "old", { reason: "timeout", nextAttempt: 2, delayMs: 1_000 });
  assert.deepEqual(h.waits, []);
  h.network("model_request_completed", "new", { durationMs: 0 });
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 1);
  h.observer.unsubscribe();
});

test("many successful requests retain accurate counts after bounded completed-history eviction", () => {
  const h = harness();
  h.begin();
  h.network("model_request_started", "long-running", { queryId: "long-query" });
  for (let i = 0; i < 300; i++) {
    h.clock.advance(1);
    h.network("model_request_started", `request-${i}`);
    h.network("model_request_completed", `request-${i}`, { durationMs: 0 });
  }
  const before = h.output.length;
  h.network("model_request_completed", "request-0", { durationMs: 0 });
  assert.equal(h.output.length, before, "an evicted completion without an active start is ignored");
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 300);
  assert.equal(h.output.at(-1)?.activity.requestId, "long-running");
  h.network("model_request_completed", "long-running", { queryId: "long-query", durationMs: 300 });
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 301);
  assert.equal(h.output.at(-1)?.activity.kind, "unknown");
  h.observer.unsubscribe();
});

test("runner started source time may precede admission without losing the successful physical request", () => {
  const h = harness();
  h.begin();
  h.network("model_request_queued", "queued", {}, EPOCH + 10);
  h.network("model_request_admitted", "queued", { queuedMs: 990 }, EPOCH + 1_000);
  h.network("model_request_started", "queued", {}, EPOCH);
  assert.deepEqual(h.output.at(-1)?.activity, {
    kind: "model",
    observedAt: EPOCH,
    since: EPOCH,
    requestsCompleted: 0,
    toolCalls: 0,
    requestId: "queued",
  });
  h.network("model_request_completed", "queued", { durationMs: 1_010 }, EPOCH + 1_010);
  assert.equal(h.output.at(-1)?.activity.requestsCompleted, 1);
  assert.equal(h.output.at(-1)?.activity.lastRequestCompletedAt, EPOCH + 1_010);
  h.observer.unsubscribe();
});
