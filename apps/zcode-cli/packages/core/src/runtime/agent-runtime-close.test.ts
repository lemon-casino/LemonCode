import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext, TraceId } from "@zcode/contracts";
import { createRuntimeTaskTerminalCleanupOwner } from "../subagent/runner.js";
import { AgentRuntime } from "./agent-runtime.js";
import { admitPrompt } from "./methods/prompt-admission.js";
import {
  retainSessionStoreDependentCloseWork,
  settleSessionStoreDependentCloseWork,
} from "./methods/session-store-dependent-close-work.js";

function createDeferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("closeBrowserSession retries a failed runtime-scope release without repeating closed resources", async () => {
  let releaseAttempts = 0;
  let browserCloseCalls = 0;
  let schedulerShutdownCalls = 0;
  const runtime = {
    beginShutdown: AgentRuntime.prototype.beginShutdown,
    browserSessionCloseTimeoutMs: 6_000,
    browserControlPort: {
      closeSession: async () => {
        browserCloseCalls += 1;
      },
    },
    executionFailoverPolicyPort: {
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("release append failed");
      },
    },
    executionFailoverScope: {
      backgroundWorkId: "actor-close-retry",
      foregroundExecutionId: "foreground-close-retry",
    },
    executionFailoverScopeLifetime: "runtime",
    executionFailoverScopeRetained: true,
    logger: { warn: () => {} },
    memoryExtractionScheduler: {
      shutdown: () => {
        schedulerShutdownCalls += 1;
      },
    },
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    residencyBlockingWorkCount: 0,
    rootTraceContext: {} as TraceContext,
    runtimeTaskRegistry: { all: () => ({}) },
    sessionId: "actor-close-retry",
    shuttingDown: false,
    trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T> {
      this.residencyBlockingWorkCount += 1;
      return work.finally(() => {
        this.residencyBlockingWorkCount -= 1;
      });
    },
  } as unknown as AgentRuntime;

  await assert.rejects(
    AgentRuntime.prototype.closeBrowserSession.call(runtime),
    /release append failed/,
  );
  assert.equal(releaseAttempts, 1);
  assert.equal(browserCloseCalls, 1);
  assert.equal(
    (runtime as unknown as { executionFailoverScopeRetained: boolean })
      .executionFailoverScopeRetained,
    true,
  );

  await AgentRuntime.prototype.closeBrowserSession.call(runtime);
  await AgentRuntime.prototype.closeBrowserSession.call(runtime);

  assert.equal(releaseAttempts, 2);
  assert.equal(browserCloseCalls, 1);
  assert.equal(schedulerShutdownCalls, 1);
  assert.equal(
    (runtime as unknown as { executionFailoverScopeRetained: boolean })
      .executionFailoverScopeRetained,
    false,
  );
});

test("closeBrowserSession waits for a retained subagent cleanup retry", async () => {
  let releaseAttempts = 0;
  let retry: (() => void) | undefined;
  let browserCloseCalls = 0;
  const runtime = {
    beginShutdown: AgentRuntime.prototype.beginShutdown,
    browserSessionCloseTimeoutMs: 6_000,
    browserControlPort: {
      closeSession: async () => {
        browserCloseCalls += 1;
      },
    },
    browserSessionClosed: false,
    executionFailoverScopeLifetime: "turn",
    nodeReplSessionDisposed: true,
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    residencyBlockingWorkCount: 0,
    rootTraceContext: {} as TraceContext,
    runtimeTaskRegistry: { all: () => ({}) },
    sessionId: "parent-close-retry",
    shutdownStarted: false,
    shuttingDown: false,
    trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T> {
      this.residencyBlockingWorkCount += 1;
      return work.finally(() => {
        this.residencyBlockingWorkCount -= 1;
      });
    },
  } as unknown as AgentRuntime;
  const owner = createRuntimeTaskTerminalCleanupOwner({
    emitParentEvent: async () => undefined,
    runtimeTaskTerminalCleanup: {
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("cleanup append failed");
      },
      retain: (work) => {
        retainSessionStoreDependentCloseWork(runtime as never, work);
      },
      scheduleRetry: (scheduledRetry) => {
        retry = scheduledRetry;
      },
    },
    runExploreAgent: async () => ({
      events: [],
      response: "done",
      traceId: "trace-parent-close-retry" as TraceId,
    }),
  });
  await owner.complete({
    agentId: "agent-close-retry",
    runTraceContext: {
      traceId: "trace-parent-close-retry" as TraceId,
      spanId: "span-parent-close-retry",
    },
  });
  assert.equal(releaseAttempts, 1);

  let closeSettled = false;
  const closing = AgentRuntime.prototype.closeBrowserSession.call(runtime).then(() => {
    closeSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false);

  retry?.();
  await closing;

  assert.equal(releaseAttempts, 2);
  assert.equal(closeSettled, true);
  assert.equal(browserCloseCalls, 1);
  assert.equal(
    (runtime as unknown as { pendingSessionStoreDependentCloseWork: Set<Promise<void>> })
      .pendingSessionStoreDependentCloseWork.size,
    0,
  );
});

test("closeBrowserSession bounds a hung browser backend before durable work can settle", async () => {
  const runtime = {
    beginShutdown: AgentRuntime.prototype.beginShutdown,
    browserControlPort: {
      closeSession: () => new Promise<void>(() => undefined),
    },
    browserSessionCloseTimeoutMs: 1,
    browserSessionClosed: false,
    executionFailoverScopeLifetime: "turn",
    memoryExtractionScheduler: undefined,
    nodeReplSessionDisposed: true,
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    rootTraceContext: {} as TraceContext,
    runtimeTaskRegistry: { all: () => ({}) },
    sessionId: "actor-browser-timeout",
    shutdownStarted: false,
    shuttingDown: false,
  } as unknown as AgentRuntime;

  await AgentRuntime.prototype.closeBrowserSession.call(runtime);

  assert.equal(
    (runtime as unknown as { browserSessionClosed: boolean }).browserSessionClosed,
    true,
  );
});

test("beginShutdown retains active subagent stop work before stable drain", async () => {
  const stopped = createDeferred<undefined>();
  let stopCalls = 0;
  const runtime = {
    memoryExtractionScheduler: undefined,
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    residencyBlockingWorkCount: 0,
    runtimeTaskRegistry: {
      all: () => ({
        "agent-shutdown": {
          agentId: "agent-shutdown",
          status: "running",
          taskId: "agent-shutdown",
          type: "local_agent",
        },
      }),
    },
    shutdownStarted: false,
    shuttingDown: false,
    subagentPort: {
      stopTask: async () => {
        stopCalls += 1;
        return stopped.promise;
      },
    },
    trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T> {
      this.residencyBlockingWorkCount += 1;
      return work.finally(() => {
        this.residencyBlockingWorkCount -= 1;
      });
    },
  } as unknown as AgentRuntime;

  AgentRuntime.prototype.beginShutdown.call(runtime);

  assert.equal(stopCalls, 1);
  assert.equal(
    (runtime as unknown as { pendingSessionStoreDependentCloseWork: Set<Promise<void>> })
      .pendingSessionStoreDependentCloseWork.size,
    1,
  );
  stopped.resolve(undefined);
  await settleSessionStoreDependentCloseWork(runtime as never);
});

test("prompt admission rejects new work after shutdown begins", async () => {
  const receipt = await admitPrompt.call({ shuttingDown: true } as never, "late prompt");
  assert.deepEqual(receipt, { kind: "rejected", reason: "no_active_turn" });
});

test("stable close drain waits for pending siblings before reporting a retained failure", async () => {
  const sibling = createDeferred<void>();
  const runtime = {
    pendingSessionStoreDependentCloseWork: new Set<Promise<void>>(),
    residencyBlockingWorkCount: 0,
    trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T> {
      this.residencyBlockingWorkCount += 1;
      return work.finally(() => {
        this.residencyBlockingWorkCount -= 1;
      });
    },
  };
  retainSessionStoreDependentCloseWork(runtime as never, Promise.reject(new Error("first failed")));
  retainSessionStoreDependentCloseWork(runtime as never, sibling.promise);

  let drainSettled = false;
  const draining = settleSessionStoreDependentCloseWork(runtime as never).finally(() => {
    drainSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(drainSettled, false);
  sibling.resolve();
  await assert.rejects(draining, /first failed/);
  assert.equal(drainSettled, true);
  assert.equal(runtime.pendingSessionStoreDependentCloseWork.size, 0);
});
