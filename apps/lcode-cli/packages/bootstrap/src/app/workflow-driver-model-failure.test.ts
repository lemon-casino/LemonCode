import assert from "node:assert/strict";
import test from "node:test";
import type { AskWaitInfo, InstanceRef, WorkflowReportSink } from "@lcode/dynamic-workflow";
import { handleModelTurnFailure } from "./workflow-driver-model-failure.js";
import type { SessionState } from "./workflow-driver-types.js";

const instance: InstanceRef = { siteId: "ask#1", ordinal: 1 };
const transientFailure = {
  name: "AiSdkModelAdapterError",
  message: "fixture transport failure",
  code: "network_error",
  context: { reason: "network_error", retryable: true },
};

test("driver redrive reports the next physical attempt without changing its backoff or internal retry count", () => {
  const waits: AskWaitInfo[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const state = {
    currentInstance: instance,
    actor: { siteId: "actor#1", ordinal: 1 },
    actorName: "fixture",
    transientAttempts: 0,
    cancelled: false,
    accepted: false,
  } as SessionState;
  let redriven = 0;
  const host = {
    deps: {
      clock: {
        random: () => 1,
        schedule: (callback: () => void, delay: number) => {
          timers.push({ callback, delay });
          return () => {};
        },
      },
    },
    sink: {
      askWaiting: (_instance: InstanceRef, wait: AskWaitInfo) => {
        waits.push(wait);
      },
    } as WorkflowReportSink,
    isDisposed: () => false,
    runTurn: () => {
      redriven++;
    },
  };
  assert.equal(handleModelTurnFailure(host, state, instance, transientFailure), true);
  assert.deepEqual(waits, [
    { cause: "backoff", reason: "network_error", attempt: 2, delayMs: 2_000 },
  ]);
  assert.equal(state.transientAttempts, 1);
  assert.equal(timers[0]?.delay, 2_000);
  timers[0]?.callback();
  assert.equal(redriven, 1);
  handleModelTurnFailure(host, state, instance, transientFailure);
  assert.deepEqual(waits.at(-1), {
    cause: "backoff",
    reason: "network_error",
    attempt: 3,
    delayMs: 4_000,
  });
  assert.equal(state.transientAttempts, 2);
  state.cancelled = true;
  timers[1]?.callback();
  assert.equal(redriven, 1);
});
