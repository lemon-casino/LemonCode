import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelFailureReason,
  ModelTransportKind,
  type ModelNetworkStatusEvent,
  type ModelRequestStartedStatusEvent,
} from "@lcode/contracts/model";
import type {
  ModelAttemptSpanWriter,
  ModelCallSpanWriter,
  ModelExecutionTelemetryPort,
} from "@lcode/contracts/telemetry";
import { NoopAgentExecutionTelemetry } from "./agent-trace-runtime.js";
import { ModelApiTelemetryStatusSink } from "./model-api-recorder.js";

function started(
  logicalCallId: string,
  sessionId = "session-fixture",
  attempt = 1,
): ModelRequestStartedStatusEvent {
  return {
    type: "model_request_started",
    timestamp: "2026-01-01T00:00:00.000Z",
    traceId: "trace-fixture",
    sessionId,
    requestId: `${logicalCallId}-${attempt}`,
    providerId: "fixture",
    modelId: "fixture-model",
    baseURL: "https://example.invalid/v1",
    providerKind: "openai",
    transport: ModelTransportKind.Sse,
    attempt,
    maxAttempts: 2,
    modelCall: {
      logicalCallId,
      operation: "agent_step",
      actorKind: "main",
      reasoning: {
        capability: "unknown",
        requestedState: "unknown",
        requestedControl: "unknown",
        effectiveState: "unknown",
        effectiveControl: "unknown",
      },
    },
  } as ModelRequestStartedStatusEvent;
}

function fixture(options: { maxActiveCalls?: number; maxActiveCallAgeMs?: number } = {}) {
  let time = 0;
  const observations: Array<[string, ...unknown[]]> = [];
  const noop = new NoopAgentExecutionTelemetry();
  const execution: ModelExecutionTelemetryPort = {
    startCall(input) {
      observations.push(["call", input.logicalCallId]);
      const writer: ModelCallSpanWriter = {
        ...noop.startCall(),
        startAttempt(attempt) {
          observations.push(["attempt", attempt]);
          const attemptWriter: ModelAttemptSpanWriter = {
            ...noop.startCall().startAttempt(attempt),
            finishAbandoned: (reason) => {
              observations.push(["attempt.abandon", attempt.requestId, reason]);
            },
            finishFailed: (...args) => {
              observations.push(["attempt.failed", ...args]);
            },
            finishCompleted: () => {
              observations.push(["attempt.completed", attempt.requestId]);
            },
          };
          return attemptWriter;
        },
        finishAbandoned: (reason) => {
          observations.push(["call.abandon", input.logicalCallId, reason]);
        },
        finishCompleted: () => {
          observations.push(["call.completed", input.logicalCallId]);
        },
      };
      return writer;
    },
  };
  const sink = new ModelApiTelemetryStatusSink({
    ...options,
    modelExecution: execution,
    now: () => time,
  });
  return {
    sink,
    observations,
    clock: (value: number) => {
      time = value;
    },
  };
}

test("recorder retains retry linkage and duplicate-start idempotency", () => {
  const f = fixture();
  const first = started("call-fixture");
  f.sink.publish(first);
  f.sink.publish(first);
  f.sink.publish({
    ...first,
    type: "model_request_failed",
    reason: ModelFailureReason.NetworkError,
    retryable: true,
    message: "fixture",
    errorPhase: "stream",
  });
  f.sink.publish({
    ...first,
    type: "model_retry_scheduled",
    delayMs: 25,
    nextAttempt: 2,
    reason: "network_error",
    message: "fixture",
  } as ModelNetworkStatusEvent);
  const second = started("call-fixture", "session-fixture", 2);
  f.sink.publish(second);
  f.sink.publish({ ...second, type: "model_request_completed", durationMs: 5 });
  assert.equal(f.sink.activeCallCount, 0);
  const attempts = f.observations.filter(([kind]) => kind === "attempt");
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(attempts[1][1] as object).filter(([key]) =>
        ["attemptCause", "previousRequestId", "retryDelayMs"].includes(key),
      ),
    ),
    {
      attemptCause: "retry",
      previousRequestId: "call-fixture-1",
      retryDelayMs: 25,
    },
  );
  assert.deepEqual(f.observations.slice(-2), [
    ["attempt.completed", "call-fixture-2"],
    ["call.completed", "call-fixture"],
  ]);
});

test("recorder capacity evicts least-recent activity and closes attempts before calls", () => {
  const f = fixture({ maxActiveCalls: 2 });
  f.sink.publish(started("a"));
  f.clock(10);
  f.sink.publish(started("b"));
  f.clock(20);
  f.sink.publish({ ...started("a"), type: "model_first_text", elapsedMs: 20 });
  f.clock(30);
  f.sink.publish(started("c"));
  assert.equal(f.sink.activeCallCount, 2);
  assert.deepEqual(
    f.observations.filter(([kind]) => kind.endsWith("abandon")),
    [
      ["attempt.abandon", "b-1", "missing_terminal"],
      ["call.abandon", "b", "missing_terminal"],
    ],
  );
  f.sink.shutdown();
  f.sink.shutdown();
  assert.equal(f.sink.activeCallCount, 0);
  assert.equal(f.observations.filter(([kind]) => kind === "call.abandon").length, 3);
});

test("recorder sweeps at the original age boundary and isolates session cleanup", () => {
  const f = fixture({ maxActiveCallAgeMs: 100 });
  f.sink.publish(started("expired", "old-session"));
  f.clock(99);
  f.sink.publish(started("retained", "keep-session"));
  assert.equal(f.sink.activeCallCount, 2);
  f.clock(100);
  f.sink.publish({
    ...started("retained", "keep-session"),
    type: "model_first_text",
    elapsedMs: 1,
  });
  assert.equal(f.sink.activeCallCount, 1);
  f.sink.abandonSession("unrelated");
  assert.equal(f.sink.activeCallCount, 1);
  f.sink.abandonSession("keep-session");
  assert.equal(f.sink.activeCallCount, 0);
  assert.deepEqual(
    f.observations.filter(([kind]) => kind === "call.abandon"),
    [
      ["call.abandon", "expired", "missing_terminal"],
      ["call.abandon", "retained", "session_shutdown"],
    ],
  );
});
