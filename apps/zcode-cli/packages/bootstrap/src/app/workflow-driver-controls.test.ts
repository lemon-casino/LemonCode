import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryJournalStore,
  type InstanceRef,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { AgentRuntime } from "@zcode/core";
import {
  createActorRuntimeCloseRetryTimer,
  createAgentRuntimeWorkflowDriver,
} from "./workflow-driver.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

test("an old cancelled turn cannot fail a retried ask or start alongside it", async () => {
  const turns: { reject: (reason: unknown) => void }[] = [];
  const failed: InstanceRef[] = [];
  const runtime = {
    executeTurn: () =>
      new Promise<never>((_resolve, reject) => {
        turns.push({ reject });
      }),
    closeBrowserSession: async () => {},
  } as unknown as AgentRuntime;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: (instance: InstanceRef) => failed.push(instance),
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "control-test",
    journal,
    emit: () => {},
    runtimeFactory: () => runtime,
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
  const session = await driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  const first: InstanceRef = { siteId: "ask#1", ordinal: 1 };
  const second: InstanceRef = { ...first, attempt: 2 };
  driver.startAsk(session, first, { instructions: "first", typed: false });
  await Promise.resolve();
  assert.equal(turns.length, 1);
  driver.cancelAsk(first);
  driver.startAsk(session, second, { instructions: "retry", typed: false });
  assert.equal(turns.length, 1, "the same actor runtime must not run two turns at once");
  turns[0]!.reject(new Error("late rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failed, []);
  assert.equal(turns.length, 2);
  driver.cancelAsk(first);
  turns[1]!.reject(new Error("current failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failed, [second]);
  driver.dispose?.();
});

test("workflow image refs become actual turn images and missing refs do not start a text-only turn", async () => {
  const calls: unknown[][] = [];
  const failed: InstanceRef[] = [];
  const runtime = {
    executeTurn: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ response: "ok" });
    },
    closeBrowserSession: async () => {},
  } as unknown as AgentRuntime;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: (instance: InstanceRef) => failed.push(instance),
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "image-test",
    journal,
    emit: () => {},
    runtimeFactory: () => runtime,
    artifactStore: {
      readToolResultArtifact: async ({ uri }: { uri: string }) => {
        if (uri.endsWith("missing")) throw new Error("not found");
        return { content: "data:image/png;base64,AA==" };
      },
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
  const session = await driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  driver.startAsk(
    session,
    { siteId: "ask#1", ordinal: 1 },
    {
      instructions: "inspect",
      typed: false,
      attachments: [
        { ref: "zcode-artifact://image", fileName: "image.png", mime: "image/png", bytes: 1 },
      ],
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((calls[0]?.[1] as Array<{ type: string; content: string }>)[0]?.type, "image");
  assert.equal(
    (calls[0]?.[1] as Array<{ type: string; content: string }>)[0]?.content,
    "zcode-artifact://image",
  );
  driver.startAsk(
    session,
    { siteId: "ask#2", ordinal: 1 },
    {
      instructions: "inspect",
      typed: false,
      attachments: [
        { ref: "zcode-artifact://missing", fileName: "missing.png", mime: "image/png", bytes: 1 },
      ],
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(failed.at(-1)?.siteId, "ask#2");
  driver.dispose?.();
});

test("dispose retains failed actor runtimes and retries without closing successful runtimes twice", async () => {
  const closeCalls = new Map<number, number>();
  const scheduled: Array<() => void> = [];
  const cleanupWork: Promise<unknown>[] = [];
  const warnings: string[] = [];
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: () => {},
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "close-retry-test",
    journal,
    emit: () => {},
    runtimeFactory: ({ actor }: { actor: { ordinal: number } }) =>
      ({
        closeBrowserSession: async () => {
          const attempts = (closeCalls.get(actor.ordinal) ?? 0) + 1;
          closeCalls.set(actor.ordinal, attempts);
          if (actor.ordinal === 2 && attempts === 1) throw new Error("release append failed");
        },
      }) as unknown as AgentRuntime,
    clock: {
      schedule: (callback: () => void) => {
        scheduled.push(callback);
        return () => {};
      },
    },
    registerResidencyBlockingWork: (work: Promise<unknown>) => cleanupWork.push(work),
    logger: {
      warn: (message: string) => warnings.push(message),
    },
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
  await driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  await driver.createActorSession({ siteId: "agent#1", ordinal: 2 }, {});

  driver.dispose?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  const sessions = (driver as unknown as { sessions: Map<string, unknown> }).sessions;
  assert.equal(closeCalls.get(1), 1);
  assert.equal(closeCalls.get(2), 1);
  assert.equal(sessions.size, 1, "the failed runtime must remain owned until close succeeds");
  assert.equal(scheduled.length, 1);
  assert.equal(cleanupWork.length, 1);
  assert.equal(warnings.length, 1);
  const cleanup = cleanupWork[0];
  assert.ok(cleanup);
  let cleanupResolved = false;
  void cleanup.then(() => {
    cleanupResolved = true;
  });
  await Promise.resolve();
  assert.equal(cleanupResolved, false, "residency must remain held while a runtime awaits retry");

  scheduled.shift()?.();
  await cleanup;

  assert.equal(closeCalls.get(1), 1, "an already closed runtime must not be closed again");
  assert.equal(closeCalls.get(2), 2);
  assert.equal(sessions.size, 0);

  driver.dispose?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeCalls.get(1), 1);
  assert.equal(closeCalls.get(2), 2);
});

test("the production actor close retry timer keeps the process alive", () => {
  const timer = createActorRuntimeCloseRetryTimer(() => undefined, 60_000);
  try {
    assert.equal(timer.hasRef(), true);
  } finally {
    clearTimeout(timer);
  }
});

test("dispose waits for an in-flight actor runtime factory and closes its late runtime", async () => {
  let resolveRuntime!: (runtime: AgentRuntime) => void;
  const runtimeReady = new Promise<AgentRuntime>((resolve) => {
    resolveRuntime = resolve;
  });
  let resolveClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const cleanupWork: Promise<unknown>[] = [];
  let closeCalls = 0;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: () => {},
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "late-runtime-test",
    journal,
    emit: () => {},
    runtimeFactory: () => runtimeReady,
    registerResidencyBlockingWork: (work: Promise<unknown>) => cleanupWork.push(work),
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);

  const creating = driver.createActorSession({ siteId: "agent#1", ordinal: 1 }, {});
  await Promise.resolve();
  driver.dispose?.();
  assert.equal(cleanupWork.length, 1);
  let cleanupResolved = false;
  void cleanupWork[0]!.then(() => {
    cleanupResolved = true;
  });
  await Promise.resolve();
  assert.equal(cleanupResolved, false, "in-flight runtime creation must hold dispose residency");

  resolveRuntime({
    closeBrowserSession: async () => {
      closeCalls += 1;
      await closeReady;
    },
  } as unknown as AgentRuntime);
  await creating;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  assert.equal(cleanupResolved, false, "late runtime close must remain part of dispose completion");

  resolveClose();
  await cleanupWork[0];
  assert.equal(cleanupResolved, true);
  assert.equal(closeCalls, 1);
  await assert.rejects(
    driver.createActorSession({ siteId: "agent#2", ordinal: 1 }, {}),
    /after driver dispose/i,
  );
  assert.equal(closeCalls, 1);
});

test("seed failure during dispose keeps the created runtime owned until close succeeds", async () => {
  let rejectSeed!: (reason: unknown) => void;
  const seedRead = new Promise<never>((_resolve, reject) => {
    rejectSeed = reject;
  });
  let seedStartedResolve!: () => void;
  const seedStarted = new Promise<void>((resolve) => {
    seedStartedResolve = resolve;
  });
  let resolveClose!: () => void;
  const closeReady = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const cleanupWork: Promise<unknown>[] = [];
  let closeCalls = 0;
  const journal = new InMemoryJournalStore();
  const sink = {
    askFailed: () => {},
    askProgress: () => {},
    askStats: () => {},
    askTurnEnded: () => {},
    askSubmitAttempted: () => {},
    askWaiting: () => {},
    askExecuting: () => {},
    askMutating: () => {},
    stopRun: () => {},
    runStalled: () => {},
    concurrencyChanged: () => {},
  } satisfies WorkflowReportSink;
  const deps = {
    runId: "seed-failure-close-test",
    journal,
    emit: () => {},
    actorTranscriptStore: {
      messages: () => {
        seedStartedResolve();
        return seedRead;
      },
      saveMessage: async () => undefined,
      savePart: async () => undefined,
    },
    runtimeFactory: () =>
      ({
        closeBrowserSession: async () => {
          closeCalls += 1;
          await closeReady;
        },
      }) as unknown as AgentRuntime,
    registerResidencyBlockingWork: (work: Promise<unknown>) => cleanupWork.push(work),
  } as unknown as AgentRuntimeWorkflowDriverDeps;
  const driver = createAgentRuntimeWorkflowDriver(deps)(sink);

  const creating = driver.createActorSession(
    { siteId: "agent#1", ordinal: 1 },
    {},
    { messageCount: 1, sourceSessionId: "source-session" },
  );
  await seedStarted;
  driver.dispose?.();
  rejectSeed(new Error("seed read failed"));
  await assert.rejects(creating, /seed read failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    cleanupWork.length,
    2,
    "dispose and failed-session close must both retain ownership",
  );
  assert.equal(closeCalls, 1);
  const sessions = (driver as unknown as { sessions: Map<string, unknown> }).sessions;
  assert.equal(sessions.size, 1);

  resolveClose();
  await Promise.all(cleanupWork);
  assert.equal(sessions.size, 0);
  assert.equal(closeCalls, 1);
});
