import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeInternal } from "../internal.js";
import { admitPrompt } from "./prompt-admission.js";
import {
  hasActiveOrQueuedTurnWork,
  isForegroundExecutionIdleForPromotion,
} from "./runtime-command-queue.js";

function runtimeFixture() {
  const queued: unknown[] = [];
  const runtime = {
    sessionId: "session-fixture",
    rootTraceContext: { traceId: "trace-fixture" },
    turnNumber: 1,
    foregroundPromotionLease: { leaseId: "lease", promotedInputId: "queued-input" },
    runtimeCommandDrainActive: false,
    runtimeCommandQueue: { hasPending: () => true },
    reserveTurnStart: () => undefined,
    enqueueRuntimeCommand: (command: unknown) => {
      queued.push(command);
    },
    hasActiveOrQueuedTurnWork() {
      return hasActiveOrQueuedTurnWork.call(this as unknown as AgentRuntimeInternal);
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, queued };
}

test("matching promotion lease admits new input ahead of pending background notifications", async () => {
  const f = runtimeFixture();
  const result = await admitPrompt.call(f.runtime, "new message", undefined, {
    requireIdle: true,
    inputId: "queued-input",
  });
  assert.equal(result.kind, "started");
  assert.equal(f.queued.length, 1);
});

test("another input cannot borrow the promotion lease", async () => {
  const f = runtimeFixture();
  const result = await admitPrompt.call(f.runtime, "other message", undefined, {
    requireIdle: true,
    inputId: "other-input",
  });
  assert.equal(result.kind, "rejected");
  assert.equal(f.queued.length, 0);
});

test("promotion still waits for the old foreground execution", async () => {
  const f = runtimeFixture();
  f.runtime.activeForegroundExecution = {
    foregroundExecutionId: "old",
  } as AgentRuntimeInternal["activeForegroundExecution"];
  const result = await admitPrompt.call(f.runtime, "new message", undefined, {
    requireIdle: true,
    inputId: "queued-input",
  });
  assert.equal(result.kind, "rejected");
  assert.equal(f.queued.length, 0);
});

test("idle barrier includes durable command finalization, not the lease or queued notifications", () => {
  const f = runtimeFixture();
  assert.equal(isForegroundExecutionIdleForPromotion.call(f.runtime), true);
  f.runtime.runtimeCommandDrainActive = true;
  assert.equal(isForegroundExecutionIdleForPromotion.call(f.runtime), false);
  f.runtime.runtimeCommandDrainActive = false;
  assert.equal(isForegroundExecutionIdleForPromotion.call(f.runtime), true);
});
