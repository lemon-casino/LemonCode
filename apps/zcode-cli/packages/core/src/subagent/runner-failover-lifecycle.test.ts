import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionEventType,
  type SessionEvent,
  type SessionId,
  type SubagentSendMessageRequest,
  type SubagentStartRequest,
  type TraceContext,
  type TraceId,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../runtime-task/registry.js";
import { createExploreSubagentPort, createRuntimeTaskTerminalCleanupOwner } from "./runner.js";

const traceContext = {
  traceId: "trace_subagent_failover" as TraceId,
} as TraceContext;

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function createRequest(outputRootDir: string): SubagentStartRequest {
  return {
    agentType: "general-purpose",
    description: "lifecycle test",
    parentToolCallId: "tool-call-1",
    prompt: "finish",
    sessionId: "session-parent" as SessionId,
    trace: traceContext,
    workingDirectory: outputRootDir,
    workspaceRoot: outputRootDir,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject(reason: unknown): void;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function completedRuntimeResult(response: string) {
  return {
    events: [],
    response,
    traceId: traceContext.traceId,
  };
}

function createMessage(taskId: string, outputRootDir: string): SubagentSendMessageRequest {
  return {
    message: "continue after stop",
    parentToolCallId: "tool-call-resume",
    sessionId: "session-parent" as SessionId,
    summary: "resume",
    to: taskId,
    trace: traceContext,
    workingDirectory: outputRootDir,
    workspaceRoot: outputRootDir,
  };
}

class StopCommitRaceRegistry extends InMemoryRuntimeTaskRegistry {
  private armedTaskId: string | undefined;
  private readsAfterArm = 0;

  armProviderTerminalCommit(taskId: string): void {
    this.armedTaskId = taskId;
    this.readsAfterArm = 0;
  }

  override get(id: string) {
    const current = super.get(id);
    if (id !== this.armedTaskId || !current) return current;
    this.readsAfterArm += 1;
    if (this.readsAfterArm === 2) {
      this.armedTaskId = undefined;
      super.update(id, (task) => ({
        ...task,
        completedAt: new Date(),
        status: "completed",
      }));
    }
    return current;
  }
}

test("background terminal commit invokes execution failover target cleanup", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-failover-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const cleaned: string[] = [];
  const retained: Promise<void>[] = [];
  try {
    const port = createExploreSubagentPort({
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      runtimeTaskTerminalCleanup: {
        release: async (taskId) => {
          cleaned.push(taskId);
        },
        retain: (work) => {
          retained.push(work);
        },
      },
      outputRootDir,
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return {
          events: [],
          response: "done",
          traceId: traceContext.traceId,
        };
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);
    const started = await port.start(createRequest(outputRootDir));
    const terminal = await port.waitForTask(started.backgroundTaskId!);
    await waitForCondition(() => retained.length === 1, "cleanup owner was not retained");
    await retained[0];

    assert.equal(terminal?.status, "completed");
    assert.deepEqual(cleaned, [started.backgroundTaskId]);
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("ordinary subagent cleanup remains exclusively owned by the registry terminal boundary", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-terminal-owner-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const childTurnCompleted = createDeferred<void>();
  const allowRegistryTerminal = createDeferred<void>();
  let releaseAttempts = 0;
  try {
    const port = createExploreSubagentPort({
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      runtimeTaskTerminalCleanup: {
        release: async () => {
          releaseAttempts += 1;
        },
        retain: () => undefined,
      },
      outputRootDir,
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        childTurnCompleted.resolve();
        await allowRegistryTerminal.promise;
        return completedRuntimeResult("done");
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);

    const started = await port.start(createRequest(outputRootDir));
    await childTurnCompleted.promise;

    assert.equal(registry.get(started.backgroundTaskId!)?.status, "running");
    assert.equal(releaseAttempts, 0);

    allowRegistryTerminal.resolve();
    const terminal = await port.waitForTask(started.backgroundTaskId!);
    await waitForCondition(() => releaseAttempts === 1, "terminal owner did not release target");

    assert.equal(terminal?.status, "completed");
    assert.equal(releaseAttempts, 1);
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("failed terminal cleanup stays owned until retry succeeds without repeating release", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-failover-retry-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const retries: Array<() => void> = [];
  let releaseAttempts = 0;
  let retained: Promise<void> | undefined;
  try {
    const port = createExploreSubagentPort({
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      runtimeTaskTerminalCleanup: {
        release: async () => {
          releaseAttempts += 1;
          if (releaseAttempts === 1) throw new Error("policy append failed");
        },
        retain: (work) => {
          assert.equal(retained, undefined);
          retained = work;
        },
        scheduleRetry: (retry) => {
          retries.push(retry);
        },
      },
      outputRootDir,
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return {
          events: [],
          response: "done",
          traceId: traceContext.traceId,
        };
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);

    const started = await port.start(createRequest(outputRootDir));
    const terminal = await port.waitForTask(started.backgroundTaskId!);
    await waitForCondition(
      () => releaseAttempts === 1 && retries.length === 1 && retained !== undefined,
      "failed cleanup was not retained for retry",
    );

    let cleanupSettled = false;
    void retained!.then(() => {
      cleanupSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(terminal?.status, "completed");
    assert.equal(cleanupSettled, false);

    const retry = retries.shift()!;
    retry();
    retry();
    await retained;
    retry();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(releaseAttempts, 2);
    assert.equal(cleanupSettled, true);
    assert.equal(registry.get(started.backgroundTaskId!)?.status, "completed");
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("terminal cleanup release cannot be configured without a retaining owner", () => {
  assert.throws(
    () =>
      createExploreSubagentPort({
        emitParentEvent: async () => undefined,
        runtimeTaskTerminalCleanup: {
          release: async () => undefined,
        } as never,
        runExploreAgent: async () => ({
          events: [],
          response: "done",
          traceId: traceContext.traceId,
        }),
      }),
    /retain/i,
  );
});

test("terminal cleanup remembers old completed generations across task resume", async () => {
  const releasedSpans: string[] = [];
  const owner = createRuntimeTaskTerminalCleanupOwner({
    emitParentEvent: async () => undefined,
    runtimeTaskTerminalCleanup: {
      release: async (_taskId, cleanupTraceContext) => {
        releasedSpans.push(cleanupTraceContext.spanId!);
      },
      retain: () => undefined,
    },
    runExploreAgent: async () => ({
      events: [],
      response: "done",
      traceId: traceContext.traceId,
    }),
  });
  const oldGeneration = {
    agentId: "agent-resumed",
    runTraceContext: { ...traceContext, spanId: "span-old" },
  };
  const resumedGeneration = {
    agentId: "agent-resumed",
    runTraceContext: { ...traceContext, spanId: "span-resumed" },
  };

  await owner.complete(oldGeneration);
  // 新代 registration 建立后，迟到的旧 terminal 不得再次 release 同一个 taskId。
  await owner.complete(oldGeneration);
  await owner.complete(resumedGeneration);
  // 新代终态不能让 owner 遗忘旧代；否则更晚的旧 terminal 会删掉新 registration。
  await owner.complete(oldGeneration);

  assert.deepEqual(releasedSpans, ["span-old", "span-resumed"]);
});

test("stop then immediate resume waits for the old background run settlement", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-stop-resume-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const oldCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const resumedCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const emitted: SessionEvent[] = [];
  const settlements: Promise<void>[] = [];
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      createAgentId: () => "agent-stop-resume",
      emitParentEvent: async (event) => {
        emitted.push(event);
      },
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        settlements.push(work);
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return runCount === 1 ? oldCompletion.promise : resumedCompletion.promise;
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);
    assert.ok(port.stopTask);
    assert.ok(port.sendMessage);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    const stopped = await port.stopTask(taskId);
    assert.equal(stopped?.status, "killed");

    const resumeRequest = createMessage(taskId, outputRootDir);
    const resumed = port.sendMessage(resumeRequest);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runCount, 1);
    assert.equal(registry.get(taskId)?.status, "killed");

    oldCompletion.resolve(completedRuntimeResult("late old result"));
    const resumeResult = await resumed;
    assert.equal(resumeResult.delivery, "resumed_background");
    assert.equal(runCount, 2);
    assert.equal(registry.get(taskId)?.status, "running");
    assert.equal(
      emitted.some((event) => {
        if (event.type !== SessionEventType.SubagentStopped) return false;
        const status = (event.payload as { status?: string }).status;
        return status === "completed" || status === "failed";
      }),
      false,
    );

    resumedCompletion.resolve(completedRuntimeResult("new result"));
    const terminal = await port.waitForTask(taskId);
    assert.equal(terminal?.status, "completed");
    await Promise.all(settlements);
  } finally {
    oldCompletion.resolve(completedRuntimeResult("cleanup old result"));
    resumedCompletion.resolve(completedRuntimeResult("cleanup resumed result"));
    await Promise.all(settlements);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("stop serializes concurrent resume and duplicate stop before a new execution starts", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-stop-mutation-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const oldCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const resumedCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const releaseGate = createDeferred<void>();
  const releaseStarted = createDeferred<void>();
  const settlements: Promise<void>[] = [];
  let notificationCount = 0;
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      createAgentId: () => "agent-stop-mutation",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => {
        notificationCount += 1;
      },
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        settlements.push(work);
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return runCount === 1 ? oldCompletion.promise : resumedCompletion.promise;
      },
      runtimeTaskRegistry: registry,
      runtimeTaskTerminalCleanup: {
        release: async () => {
          releaseStarted.resolve();
          await releaseGate.promise;
        },
        retain: () => undefined,
      },
    });
    assert.ok(port.start);
    assert.ok(port.stopTask);
    assert.ok(port.sendMessage);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    const firstStop = port.stopTask(taskId);
    await releaseStarted.promise;
    const duplicateStop = port.stopTask(taskId);
    const resumed = port.sendMessage(createMessage(taskId, outputRootDir));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(runCount, 1);
    assert.equal(registry.get(taskId)?.status, "killed");

    releaseGate.resolve();
    assert.equal((await firstStop)?.status, "killed");
    assert.equal((await duplicateStop)?.status, "killed");
    assert.equal(notificationCount, 1);
    assert.equal(runCount, 1);

    oldCompletion.resolve(completedRuntimeResult("late old result"));
    assert.equal((await resumed).delivery, "resumed_background");
    assert.equal(runCount, 2);
    assert.equal(registry.get(taskId)?.status, "running");

    resumedCompletion.resolve(completedRuntimeResult("new result"));
    assert.equal((await port.waitForTask(taskId))?.status, "completed");
    await Promise.all(settlements);
  } finally {
    releaseGate.resolve();
    oldCompletion.resolve(completedRuntimeResult("cleanup old result"));
    resumedCompletion.resolve(completedRuntimeResult("cleanup resumed result"));
    await Promise.all(settlements);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("stop loses its terminal CAS when the same provider execution already completed", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-stop-cas-"));
  const registry = new StopCommitRaceRegistry();
  const completion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const settlements: Promise<void>[] = [];
  let notificationCount = 0;
  let runSignal: AbortSignal | undefined;
  try {
    const port = createExploreSubagentPort({
      createAgentId: () => "agent-stop-cas",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => {
        notificationCount += 1;
      },
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        settlements.push(work);
      },
      runExploreAgent: async (request, options) => {
        runSignal = options?.signal;
        await request.onSessionReady?.();
        return completion.promise;
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);
    assert.ok(port.stopTask);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    registry.armProviderTerminalCommit(taskId);

    const terminal = await port.stopTask(taskId);

    assert.equal(terminal?.status, "completed");
    assert.equal(notificationCount, 0);
    assert.equal(runSignal?.aborted, false);

    completion.resolve(completedRuntimeResult("provider result"));
    await Promise.all(settlements);
  } finally {
    completion.resolve(completedRuntimeResult("cleanup result"));
    await Promise.all(settlements);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("concurrent messages create only one resumed execution for a terminal task", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-concurrent-resume-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const resumedCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      createAgentId: () => "agent-concurrent-resume",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return runCount === 1
          ? completedRuntimeResult("initial result")
          : resumedCompletion.promise;
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);
    assert.ok(port.sendMessage);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    await port.waitForTask(taskId);
    const createMessage = (suffix: string): SubagentSendMessageRequest => ({
      message: `message ${suffix}`,
      parentToolCallId: `tool-call-${suffix}`,
      sessionId: "session-parent" as SessionId,
      summary: `summary ${suffix}`,
      to: taskId,
      trace: traceContext,
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
    });

    const results = await Promise.all([
      port.sendMessage(createMessage("one")),
      port.sendMessage(createMessage("two")),
    ]);

    assert.equal(runCount, 2);
    assert.deepEqual(results.map((result) => result.delivery).sort(), [
      "queued",
      "resumed_background",
    ]);
    assert.equal(registry.get(taskId)?.status, "running");

    resumedCompletion.resolve(completedRuntimeResult("resumed result"));
    const terminal = await port.waitForTask(taskId);
    assert.equal(terminal?.status, "completed");
  } finally {
    resumedCompletion.resolve(completedRuntimeResult("cleanup resumed result"));
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("shutdown admission rejects terminal SendMessage resume without creating a generation", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-shutdown-resume-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  let accepting = true;
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      acceptRun: () => accepting,
      createAgentId: () => "agent-shutdown-resume",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return completedRuntimeResult("initial result");
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);
    assert.ok(port.sendMessage);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    assert.equal((await port.waitForTask(taskId))?.status, "completed");
    accepting = false;

    await assert.rejects(
      port.sendMessage(createMessage(taskId, outputRootDir)),
      /subagent admission is closed/i,
    );
    assert.equal(runCount, 1);
    assert.equal(registry.get(taskId)?.status, "completed");
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("shutdown during background metadata preparation prevents provider launch", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-shutdown-start-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const retained: Promise<void>[] = [];
  let accepting = true;
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      acceptRun: () => accepting,
      createAgentId: () => "agent-shutdown-start",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        retained.push(work);
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return completedRuntimeResult("must not run");
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.start);

    const starting = port.start(createRequest(outputRootDir));
    assert.equal(retained.length, 1);
    accepting = false;

    await assert.rejects(starting, /subagent admission is closed/i);
    await Promise.all(retained);
    assert.equal(runCount, 0);
    assert.equal(registry.get("agent-shutdown-start"), undefined);
    assert.equal(retained.length, 1);
  } finally {
    await Promise.all(retained);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("shutdown during foreground metadata preparation prevents provider launch", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-shutdown-run-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const retained: Promise<void>[] = [];
  let accepting = true;
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      acceptRun: () => accepting,
      createAgentId: () => "agent-shutdown-run",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        retained.push(work);
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return completedRuntimeResult("must not run");
      },
      runtimeTaskRegistry: registry,
    });

    const running = port.run(createRequest(outputRootDir));
    assert.equal(retained.length, 1);
    accepting = false;

    await assert.rejects(running, /subagent admission is closed/i);
    await Promise.all(retained);
    assert.equal(runCount, 0);
    assert.equal(registry.get("agent-shutdown-run"), undefined);
    assert.equal(retained.length, 1);
  } finally {
    accepting = false;
    await Promise.all(retained);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("foreground stop and resume wait for the old physical child settlement", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-foreground-settle-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const oldCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const resumedCompletion = createDeferred<ReturnType<typeof completedRuntimeResult>>();
  const retained: Promise<void>[] = [];
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      createAgentId: () => "agent-foreground-settle",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        retained.push(work);
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return runCount === 1 ? oldCompletion.promise : resumedCompletion.promise;
      },
      runtimeTaskRegistry: registry,
    });
    assert.ok(port.sendMessage);

    const running = port.run(createRequest(outputRootDir));
    const runningRejected = assert.rejects(running, /cancelled/i);
    await waitForCondition(() => runCount === 1, "foreground child did not start");
    const stopped = await port.stopTask?.("agent-foreground-settle");
    assert.ok(stopped && ["cancelled", "killed", "stopped"].includes(stopped.status));
    await runningRejected;

    const resuming = port.sendMessage(createMessage("agent-foreground-settle", outputRootDir));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runCount, 1, "resume must wait for the old physical child");

    oldCompletion.resolve(completedRuntimeResult("late old result"));
    await waitForCondition(() => runCount === 2, "resume did not start after old child settled");
    const resumed = await resuming;
    assert.equal(resumed.delivery, "resumed_background");

    resumedCompletion.resolve(completedRuntimeResult("new result"));
    assert.equal((await port.waitForTask("agent-foreground-settle"))?.status, "completed");
    await Promise.all(retained);
  } finally {
    oldCompletion.resolve(completedRuntimeResult("late old result"));
    resumedCompletion.resolve(completedRuntimeResult("new result"));
    await Promise.all(retained);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("shutdown while resume waits for old cleanup prevents a late generation", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-shutdown-prelaunch-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const retained: Promise<void>[] = [];
  const cleanupRetained: Promise<void>[] = [];
  const retryReady = createDeferred<void>();
  const resumePreparationRetained = createDeferred<void>();
  let accepting = true;
  let releaseAttempts = 0;
  let retry: (() => void) | undefined;
  let runCount = 0;
  try {
    const port = createExploreSubagentPort({
      acceptRun: () => accepting,
      createAgentId: () => "agent-shutdown-prelaunch",
      emitParentEvent: async () => undefined,
      enqueueParentTaskNotification: () => undefined,
      outputRootDir,
      retainBackgroundRunSettlement: (work) => {
        retained.push(work);
        if (retained.length === 3) resumePreparationRetained.resolve();
      },
      runExploreAgent: async (request) => {
        runCount += 1;
        await request.onSessionReady?.();
        return completedRuntimeResult("initial result");
      },
      runtimeTaskRegistry: registry,
      runtimeTaskTerminalCleanup: {
        release: async () => {
          releaseAttempts += 1;
          if (releaseAttempts === 1) throw new Error("policy append failed");
        },
        retain: (work) => {
          cleanupRetained.push(work);
        },
        scheduleRetry: (scheduledRetry) => {
          retry = scheduledRetry;
          retryReady.resolve();
        },
      },
    });
    assert.ok(port.start);
    assert.ok(port.sendMessage);

    const started = await port.start(createRequest(outputRootDir));
    const taskId = started.backgroundTaskId!;
    assert.equal((await port.waitForTask(taskId))?.status, "completed");
    await retryReady.promise;

    const resuming = port.sendMessage(createMessage(taskId, outputRootDir));
    await resumePreparationRetained.promise;
    accepting = false;
    retry?.();

    await assert.rejects(resuming, /subagent admission is closed/i);
    await Promise.all([...retained, ...cleanupRetained]);
    assert.equal(runCount, 1);
    assert.equal(registry.get(taskId)?.status, "completed");
    assert.equal(retained.length, 3);
  } finally {
    accepting = false;
    retry?.();
    await Promise.all([...retained, ...cleanupRetained]);
    await rm(outputRootDir, { recursive: true, force: true });
  }
});
