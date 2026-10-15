import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystemAdapter } from "@lcode/adapters";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  createSessionId,
  createRootTraceContext,
  type DynamicWorkflowRunPort,
} from "@lcode/contracts";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { InMemoryJournalStore } from "@lcode/dynamic-workflow";

async function fixture(
  t: TestContext,
  routed = true,
  held = false,
  amended = false,
  routing?: { barrier: Promise<void>; onRoute(): void },
) {
  const directory = await mkdtemp(join(tmpdir(), "lcode-original-owner-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "fixture.sqlite") });
  const parentA = createSessionId();
  const parentB = createSessionId();
  const a = await store.acquireWorkflowExecutionOwner({
    parentSessionId: parentA,
    workspaceKey: directory,
  });
  const b = await store.acquireWorkflowExecutionOwner({
    parentSessionId: parentB,
    workspaceKey: directory,
  });
  const fileSystem = createNodeFileSystemAdapter();
  let release!: () => void;
  let readStarted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await writeFile(join(directory, "held.txt"), "fixture content");
  if (amended)
    a.journal.createRun({
      runId: "predecessor",
      parentSessionId: parentA,
      status: "completed",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
    });
  a.journal.createRun({
    runId: "original-run",
    parentSessionId: parentA,
    cwd: directory,
    ...(amended ? { resumedFrom: "predecessor" } : {}),
    status: "stopped",
    stopReason: "interrupted",
    caps: { maxConcurrency: 1 },
    spentTokens: 0,
    scriptText: held ? 'return await files.read("held.txt");' : 'return "fixture resumed";',
  });
  const originalRead = fileSystem.readTextFile.bind(fileSystem);
  t.mock.method(
    fileSystem,
    "readTextFile",
    async (input: Parameters<typeof fileSystem.readTextFile>[0]) => {
      readStarted();
      if (held) await gate;
      return originalRead(input);
    },
  );
  const common = {
    executionPort: {} as never,
    createActorRuntime: () => {
      throw new Error("No actor should start");
    },
    fileSystemPort: fileSystem,
  };
  const owner = createDynamicWorkflowRunService({
    ...common,
    parentSessionId: parentA,
    journal: a.journal,
    executionOwner: a,
  });
  const routedOperations: string[] = [];
  const caller = createDynamicWorkflowRunService({
    ...common,
    parentSessionId: parentB,
    journal: b.journal,
    executionOwner: b,
    ...(routed
      ? {
          withWorkflowRunOwner: async <T>(
            request: { parentSessionId: string; operation: string },
            operation: (port: DynamicWorkflowRunPort) => Promise<T>,
          ) => {
            assert.equal(request.parentSessionId, parentA);
            routedOperations.push(request.operation);
            if (routing) {
              routing.onRoute();
              await routing.barrier;
            }
            return operation(owner);
          },
        }
      : {}),
  });
  t.after(async () => {
    release();
    await caller.close();
    await owner.close();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { owner, caller, store, parentA, parentB, waiting, release, routedOperations, directory };
}

test("cross-session resume executes through the original service and preserves parent ownership", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.caller.resume!("original-run")).ok, true);
  const result = await f.caller.waitForTask("original-run");
  assert.equal(result?.runStatus, "completed");
  assert.equal(result?.output, "fixture resumed");
  assert.equal(f.store.workflowJournalStore().getRun("original-run")?.parentSessionId, f.parentA);
  assert.deepEqual(f.routedOperations, ["resume", "waitForTask"]);
});

test("routed wait and cancellation keep using the original live owner", async (t) => {
  const f = await fixture(t, true, true);
  assert.equal((await f.caller.resume!("original-run")).ok, true);
  await f.waiting;
  assert.equal(f.owner.countLiveRuns(), 1);
  assert.equal(f.caller.countLiveRuns(), 0);
  assert.equal((await f.caller.getTask("original-run"))?.status, "running");
  const waiting = f.caller.waitForTask("original-run");
  assert.equal(await f.caller.cancel("original-run", "user"), true);
  assert.equal((await waiting)?.stopReason, "user");
  assert.ok(f.routedOperations.includes("cancel"));
});

test("missing original-owner routing refuses before any background attempt is accepted", async (t) => {
  const f = await fixture(t, false);
  const before = f.store.workflowJournalStore().listEvents("original-run");
  const result = await f.caller.resume!("original-run");
  assert.deepEqual(result, {
    ok: false,
    reason: "owner_unavailable",
    message:
      "Workflow execution owner is unavailable; open the original conversation and retry after its owner is available.",
  });
  assert.equal(f.caller.countLiveRuns(), 0);
  assert.equal(f.store.workflowJournalStore().getRun("original-run")?.status, "stopped");
  assert.deepEqual(f.store.workflowJournalStore().listEvents("original-run"), before);
});

test("concurrent same-run resumes after async import rebuilding admit only one engine", async (t) => {
  const f = await fixture(t, true, true, true);
  const results = await Promise.all([
    f.owner.resume!("original-run"),
    f.owner.resume!("original-run"),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.find((result) => !result.ok),
    { ok: false, reason: "already_running" },
  );
  await f.waiting;
  f.release();
  assert.equal((await f.owner.waitForTask("original-run"))?.runStatus, "completed");
});

test("closing while resume rebuilds imports prevents a late launch", async (t) => {
  const f = await fixture(t, true, false, true);
  const refused = assert.rejects(f.owner.resume!("original-run"), /closed/);
  await f.owner.close();
  await refused;
  assert.equal(f.owner.countLiveRuns(), 0);
  assert.equal(f.store.workflowJournalStore().getRun("original-run")?.status, "stopped");
});

test("fenced submit derives its omitted parent and rejects another explicit parent before acceptance", async (t) => {
  const f = await fixture(t);
  const request = {
    cwd: f.directory,
    scriptText: 'return "submitted";',
    trace: createRootTraceContext({ sessionId: f.parentB }),
  };
  await assert.rejects(f.caller.submit({ ...request, parentSessionId: f.parentA }));
  assert.equal(f.caller.countLiveRuns(), 0);
  const accepted = await f.caller.submit(request);
  assert.equal((await f.caller.waitForTask(accepted.runId))?.runStatus, "completed");
  assert.equal(f.store.workflowJournalStore().getRun(accepted.runId)?.parentSessionId, f.parentB);
});

test("closing during amendment import prevents its successor from launching", async (t) => {
  const f = await fixture(t);
  const refused = assert.rejects(
    f.owner.amend!({
      predecessorRunId: "original-run",
      scriptText: 'return "changed";',
      cwd: f.directory,
      parentSessionId: f.parentA,
      trace: createRootTraceContext({ sessionId: f.parentA }),
    }),
    /closed/,
  );
  await f.owner.close();
  await refused;
  assert.equal(f.owner.countLiveRuns(), 0);
});

test("ephemeral embedded journals retain local reads without inventing a durable owner", async () => {
  const port = createDynamicWorkflowRunService({
    parentSessionId: "ephemeral-parent",
    journal: new InMemoryJournalStore(),
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: {} as never,
    createActorRuntime: () => {
      throw new Error("No actor should start");
    },
  });
  try {
    const result = await port.submit({
      scriptText: "return 3;",
      cwd: process.cwd(),
      trace: createRootTraceContext(),
    });
    assert.equal((await port.waitForTask(result.runId))?.output, 3);
  } finally {
    await port.close();
  }
});

test("caller close during owner routing cannot launch in the original App afterwards", async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, true, false, false, { barrier, onRoute: entered });
  const refused = assert.rejects(f.caller.resume!("original-run"), /closed/);
  await started;
  await f.caller.close();
  release();
  await refused;
  assert.equal(f.owner.countLiveRuns(), 0);
  assert.equal(f.store.workflowJournalStore().getRun("original-run")?.status, "stopped");
});
