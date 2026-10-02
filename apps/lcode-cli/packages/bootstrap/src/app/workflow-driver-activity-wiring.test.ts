import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  createRootTraceContext,
  type ModelNetworkStatusEvent,
  type SessionEvent,
  type SessionId,
  type WorkflowSubmitPort,
} from "@lcode/contracts";
import type { AgentRuntime, ExecuteTurnOptions, TurnResult } from "@lcode/core";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type InstanceRef,
  type RunEvent,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

const EPOCH = 1_700_000_000_000;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function setup(typed = true) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const turns: Array<{
    queryId: string;
    turnId: string;
    resolve: (result: TurnResult) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const events: RunEvent[] = [];
  const journal = new InMemoryJournalStore();
  const timers = new Map<() => void, number>();
  const allTimers: Array<() => void> = [];
  let now = EPOCH;
  let sequence = 0;
  let sessionId!: SessionId;
  let submit!: WorkflowSubmitPort;
  let closed = 0;
  const emit = (type: SessionEvent["type"], payload: unknown, turnId: string, at = now) => {
    const event = {
      id: `event-${++sequence}`,
      sessionId,
      type,
      payload,
      turnId,
      timestamp: new Date(at),
      traceId: "fixture-trace",
      sequenceNumber: sequence,
    } as SessionEvent;
    for (const listener of listeners) listener(event);
  };
  const runtime = {
    subscribeEvents: ({ onSessionEvent }: { onSessionEvent: (event: SessionEvent) => void }) => {
      listeners.add(onSessionEvent);
      return () => {
        listeners.delete(onSessionEvent);
      };
    },
    executeTurn: (_input: string, _attachments: unknown, options: ExecuteTurnOptions) => {
      assert.ok(options.queryId, "driver binds observation to the actual executeTurn query");
      const queryId = String(options.queryId);
      const turnId = `turn-${turns.length + 1}`;
      return new Promise<TurnResult>((resolve, reject) => {
        turns.push({ queryId, turnId, resolve, reject });
        emit(
          SessionEventType.TurnStarted,
          { queryId, turnNumber: turns.length, input: "private" },
          turnId,
        );
      });
    },
    closeBrowserSession: async () => {
      closed++;
    },
  } as unknown as AgentRuntime;
  let engine!: WorkflowEngine;
  const sink: WorkflowReportSink = {
    askActivity: (instance, activity) => engine.askActivity(instance, activity),
    askProgress: (instance, progress) => engine.askProgress(instance, progress),
    askStats: (instance, stats) => engine.askStats(instance, stats),
    askSubmitAttempted: (instance, payload) => engine.askSubmitAttempted(instance, payload),
    askTurnEnded: (instance, text) => engine.askTurnEnded(instance, text),
    askFailed: (instance, error) => engine.askFailed(instance, error),
    askWaiting: (instance, wait) => engine.askWaiting(instance, wait),
    askExecuting: (instance) => engine.askExecuting(instance),
    askMutating: (instance) => engine.askMutating(instance),
    stopRun: (error) => engine.stopRun(error),
    runStalled: (info) => engine.runStalled(info),
    concurrencyChanged: (change) => engine.concurrencyChanged(change),
  };
  const driver = createAgentRuntimeWorkflowDriver({
    runId: "activity-wiring",
    journal,
    emit: (event: RunEvent) => events.push(event),
    runtimeFactory: (input: { sessionId: SessionId; submitPort: WorkflowSubmitPort }) => {
      sessionId = input.sessionId;
      submit = input.submitPort;
      return runtime;
    },
    clock: {
      now: () => now,
      random: () => 1,
      schedule: (callback: () => void, delayMs: number) => {
        timers.set(callback, now + delayMs);
        allTimers.push(callback);
        return () => {
          timers.delete(callback);
        };
      },
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps)(sink);
  engine = new WorkflowEngine({
    runId: "activity-wiring",
    driver,
    caps: { maxConcurrency: 1 },
    askSpecs: new Map([["ask#1", { typed }]]),
    validate: () => [],
  });
  const actor = engine.createActor("actor#1", "fixture");
  const result = engine.ask("ask#1", actor, "fixture request");
  await tick();
  const network = (
    type: ModelNetworkStatusEvent["type"],
    requestId: string,
    extra: Record<string, unknown> = {},
    turnIndex = turns.length - 1,
  ) => {
    const turn = turns[turnIndex]!;
    emit(
      SessionEventType.ModelNetworkStatus,
      {
        type,
        requestId,
        turnId: turn.turnId,
        queryId: turn.queryId,
        querySource: "workflow_child",
        timestamp: new Date(now).toISOString(),
        traceId: "fixture-trace",
        providerId: "fixture",
        modelId: "fixture",
        transport: "stream",
        attempt: 1,
        maxAttempts: 0,
        ...extra,
      },
      turn.turnId,
    );
  };
  const stream = (delta: string, kind = "text_delta", turnIndex = turns.length - 1) => {
    emit(SessionEventType.ModelStreaming, { delta, kind, done: false }, turns[turnIndex]!.turnId);
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [callback, at] of timers) {
      if (at <= now) {
        timers.delete(callback);
        callback();
      }
    }
  };
  return {
    engine,
    driver,
    result,
    events,
    journal,
    turns,
    timers,
    allTimers,
    listeners,
    emit,
    network,
    stream,
    advance,
    submit: (value: unknown) =>
      submit.respond({
        result: value,
        toolCallId: "submit",
        trace: createRootTraceContext({ sessionId }),
      }),
    closed: () => closed,
    activities: () => events.filter((event) => event.type === "node-activity"),
  };
}

function resolvedTurn(response = "fixture result"): TurnResult {
  return {
    response,
    events: [],
    usage: { totalTokens: 7, modelRequestCount: 2 },
  } as unknown as TurnResult;
}

test("production driver publishes multi-request/tool facts to the engine while a typed ask has not delivered", async () => {
  const h = await setup();
  let delivered = false;
  void h.result.then(() => {
    delivered = true;
  });
  h.network("model_request_started", "main-1");
  assert.equal(h.activities().at(-1)?.activity.kind, "model");
  h.advance(60_000);
  assert.equal(h.activities().length, 1);
  h.stream("visible reasoning", "reasoning_delta");
  h.network("model_request_completed", "main-1", { durationMs: 60_000 });
  const turn = h.turns[0]!;
  h.emit(
    SessionEventType.ToolCallStarted,
    { toolCallId: "read-1", toolName: "Read", readOnly: true, sideEffectScope: "none" },
    turn.turnId,
  );
  assert.equal(h.activities().at(-1)?.activity.toolCalls, 1);
  h.advance(30_000);
  h.emit(
    SessionEventType.ToolCallResult,
    { toolCallId: "read-1", result: "private contents" },
    turn.turnId,
  );
  assert.equal(h.activities().at(-1)?.activity.kind, "unknown");
  h.network("model_request_started", "main-2");
  h.stream("result text");
  h.advance(100);
  h.stream("pending result text");
  assert.equal(h.timers.size, 1);
  h.network("model_request_completed", "main-2", { durationMs: 100 });
  assert.equal(h.activities().at(-1)?.activity.requestsCompleted, 2);
  assert.equal(
    h.events.some((event) => event.type === "node-settled"),
    false,
  );
  assert.equal(
    h.events.some((event) => event.type === "node-progress"),
    false,
  );
  assert.equal(h.journal.getRun("activity-wiring")?.spentTokens, 0);
  assert.equal(h.journal.getNode("activity-wiring", "ask#1", 1)?.status, "running");
  assert.equal(delivered, false);

  h.emit(
    SessionEventType.ToolCallStarted,
    { toolCallId: "submit", toolName: "submit_result", sideEffectScope: "session" },
    turn.turnId,
  );
  assert.deepEqual(await h.submit({ done: true }), { accept: true });
  assert.deepEqual(await h.result, { done: true });
  assert.equal(h.timers.size, 0);
  const acceptedCount = h.activities().length;
  h.stream("late ignored");
  h.emit(SessionEventType.ToolCallResult, { toolCallId: "submit", result: "done" }, turn.turnId);
  assert.equal(h.activities().length, acceptedCount);
  turn.resolve(resolvedTurn());
  await tick();
  assert.equal(h.journal.getRun("activity-wiring")?.spentTokens, 7);
  assert.equal(h.journal.getNode("activity-wiring", "ask#1", 1)?.stats?.toolCalls, 2);
  assert.equal(h.journal.getNode("activity-wiring", "ask#1", 1)?.stats?.worldToolCalls, 1);
  h.engine.complete("done");
  await tick();
  assert.equal(h.closed(), 1);
  assert.equal(h.listeners.size, 0);
});

test("production cancel/retry/stop revoke old timers and events before reusing the actor runtime", async () => {
  const h = await setup();
  const first: InstanceRef = { siteId: "ask#1", ordinal: 1 };
  h.network("model_request_started", "old-request");
  h.stream("first");
  h.advance(10);
  h.stream("pending");
  const timer = h.allTimers.at(-1)!;
  assert.equal(h.timers.size, 1);
  assert.equal(h.engine.pauseAsk(first), true);
  assert.equal(h.timers.size, 0);
  const paused = h.activities().length;
  assert.equal(h.engine.retryAsk(first), true);
  assert.equal(h.turns.length, 1);
  h.network("model_request_completed", "old-request", { durationMs: 10 });
  h.emit(
    SessionEventType.ToolCallStarted,
    { toolCallId: "old-tool", toolName: "Write" },
    h.turns[0]!.turnId,
  );
  timer();
  assert.equal(h.activities().length, paused);
  h.turns[0]!.reject(new Error("old cancelled turn"));
  await tick();
  assert.equal(h.turns.length, 2);
  h.network("model_request_started", "new-request");
  assert.equal(h.activities().at(-1)?.instance.attempt, 2);
  assert.equal(h.activities().at(-1)?.activity.toolCalls, 0);
  const current = h.activities().length;
  h.network("model_request_completed", "old-request", { durationMs: 10 }, 0);
  h.stream("old reasoning", "reasoning_delta", 0);
  assert.equal(h.activities().length, current);
  h.stream("new text");
  h.advance(10);
  h.stream("pending new text");
  assert.equal(h.timers.size, 1);
  const stoppedTimer = h.allTimers.at(-1)!;
  const rejected = assert.rejects(h.result, /cancelled|stopped/i);
  h.engine.stop("user");
  await rejected;
  assert.equal(h.timers.size, 0);
  const stopped = h.events.length;
  stoppedTimer();
  h.network("model_request_completed", "new-request", { durationMs: 10 });
  assert.equal(h.events.length, stopped);
  h.turns[1]!.reject(new Error("cancelled"));
  await tick();
  assert.equal(h.closed(), 1);
  assert.equal(h.listeners.size, 0);
});

test("resolved turns keep progress.turn separate from successful physical requests", async () => {
  const h = await setup(false);
  for (const request of ["request-1", "request-2", "request-3"]) {
    h.network("model_request_started", request);
    h.network("model_request_completed", request, { durationMs: 0 });
  }
  const turn = h.turns[0]!;
  h.emit(SessionEventType.TurnComplete, {}, turn.turnId);
  turn.resolve(resolvedTurn("plain result"));
  assert.equal(await h.result, "plain result");
  const progress = h.events.filter((event) => event.type === "node-progress");
  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.turn, 1);
  assert.equal(h.activities().at(-1)?.activity.requestsCompleted, 3);
  assert.equal(h.events.filter((event) => event.type === "node-settled").length, 1);
  h.engine.complete("done");
  await tick();
});
