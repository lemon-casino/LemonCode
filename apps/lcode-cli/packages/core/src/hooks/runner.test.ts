import assert from "node:assert/strict";
import test from "node:test";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  type HookInput,
  type SessionEvent,
} from "@lcode/contracts";
import { createInMemoryHookRunner } from "./runner.js";
import type { HookRegistration } from "./types.js";

const input = {
  hookEventName: HookEventName.PreToolUse,
  sessionId: "hook-session",
  traceId: "hook-trace",
  toolName: "Read",
  toolCallId: "hook-call",
  toolInput: {},
} as HookInput;

function visibleHook(callback: HookRegistration["callback"]): HookRegistration {
  return {
    event: HookEventName.PreToolUse,
    callback,
    descriptor: {
      clientVisible: true,
      commandDisplay: "test hook",
      executionMode: "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: 1000,
    },
  };
}

test("hook dispatch rechecks trust after prior hooks and snapshots registrations", async () => {
  let trusted = true;
  let lateCalls = 0;
  let deniedCalls = 0;
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    emitEvent: async (event) => {
      events.push(event);
    },
  });
  runner.register(
    visibleHook(() => {
      trusted = false;
      runner.register(
        visibleHook(() => {
          lateCalls++;
        }),
      );
    }),
  );
  runner.register({
    ...visibleHook(() => {
      deniedCalls++;
    }),
    admission: () => ({ allowed: trusted, reasonCode: "revoked" }),
  });
  runner.register({
    ...visibleHook(() => {
      throw new Error("disabled hook must not execute");
    }),
    admission: () => ({ allowed: false, skipLifecycle: true }),
  });
  await runner.run(input);
  assert.equal(lateCalls, 0);
  assert.equal(deniedCalls, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunCompleted,
      SessionEventType.HookRunBlocked,
    ],
  );
  assert.ok(events.every((event) => (event.payload as { hookCount: number }).hookCount === 2));
  await runner.run(input);
  assert.equal(lateCalls, 1);
});

test("foreground hook retains configured default timeout and cancellation classification", async () => {
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    defaultTimeoutMs: 60_000,
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [
      visibleHook(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "context" },
        };
      }),
    ],
  });
  const result = await runner.run(input);
  assert.deepEqual(result.additionalContexts, ["context"]);
  assert.equal(events.at(-1)?.type, SessionEventType.HookRunCompleted);
  const controller = new AbortController();
  controller.abort();
  await runner.run(input, { signal: controller.signal });
  const failure = events.at(-1);
  assert.ok(failure);
  assert.equal(failure.type, SessionEventType.HookRunFailed);
  assert.equal((failure.payload as { outcome: HookOutcome }).outcome, HookOutcome.Cancelled);
});

test("async hook output cannot mutate the continuing action", async () => {
  const events: SessionEvent[] = [];
  const finished = Promise.withResolvers<void>();
  const resultReady = Promise.withResolvers<void>();
  const runner = createInMemoryHookRunner({
    emitEvent: async (event) => {
      events.push(event);
      if (event.type === SessionEventType.HookRunCompleted) finished.resolve();
    },
    hooks: [
      {
        ...visibleHook(async () => {
          await resultReady.promise;
          return { continue: false, stopReason: "late denial" };
        }),
        async: true,
      },
    ],
  });
  const result = await runner.run(input);
  assert.deepEqual(result, { additionalContexts: [] });
  assert.equal(events.length, 1);
  resultReady.resolve();
  await finished.promise;
  assert.deepEqual(result, { additionalContexts: [] });
});
