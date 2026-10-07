import assert from "node:assert/strict";
import test from "node:test";
import { createRootTraceContext, type TurnId } from "@lcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { continueAfterBackgroundBash } from "./background-bash-completion.js";
import { cleanupTurnBackgroundBash } from "./background.js";

function fixture() {
  const registry = new InMemoryRuntimeTaskRegistry();
  const controller = new AbortController();
  const notifications: { taskId: string; taskLifecycleId?: string; mode: string }[] = [];
  const consumed: string[] = [];
  const state = {
    turnId: "turn-a" as TurnId,
    turnAbortSignal: controller.signal,
    turnTraceContext: createRootTraceContext(),
    turnRequestState: { entries: [], outputTokenContinuationCount: 0 },
  } as unknown as RegularTurnLoopState;
  const runtime = {
    branchGeneration: 0,
    runtimeTaskRegistry: registry,
    runtimeCommandQueue: { snapshot: () => notifications },
    drainPendingRuntimeCommandsForActiveLoop: async () => {
      const drained = notifications.splice(0);
      consumed.push(...drained.map((item) => item.taskId));
      return {
        drained: drained.length,
        runtimeEntries: [],
        backgroundSubagentResultConsumed: false,
        workflowResultConsumed: false,
      };
    },
  } as unknown as AgentRuntimeInternal;
  function start(id: string, patch: Partial<RuntimeTaskSnapshot> = {}) {
    registry.register({
      taskId: id,
      agentId: id,
      agentType: "local_bash",
      description: "finite command",
      type: "local_bash",
      isBackgrounded: true,
      backgroundKind: "task",
      status: "running",
      turnId: state.turnId,
      ...patch,
    });
  }
  function settle(id: string, status: RuntimeTaskSnapshot["status"] = "completed") {
    registry.update(id, (task) => ({ ...task, status }));
    notifications.push({
      taskId: id,
      taskLifecycleId: registry.get(id)?.lifecycleId,
      mode: "task-notification",
    });
  }
  return { registry, controller, state, runtime, consumed, start, settle };
}

test("finite Bash keeps the same turn open until its real result can be consumed", async () => {
  const f = fixture();
  f.start("build");
  let finished = false;
  const wait = continueAfterBackgroundBash(f.runtime, f.state).then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(f.registry.get("build")?.cleanupOnTurnComplete, undefined);
  f.settle("build");
  assert.equal(await wait, true);
  assert.deepEqual(f.consumed, ["build"]);
  assert.equal(await continueAfterBackgroundBash(f.runtime, f.state), false);
});

for (const status of ["failed", "cancelled", "lost"] as const) {
  test(`${status} background result resumes the model instead of being hidden`, async () => {
    const f = fixture();
    f.start("build");
    const wait = continueAfterBackgroundBash(f.runtime, f.state);
    f.settle("build", status);
    assert.equal(await wait, true);
    assert.equal(f.registry.get("build")?.status, status);
    assert.deepEqual(f.consumed, ["build"]);
  });
}

test("a result delivered while the model finishes is consumed once", async () => {
  const f = fixture();
  f.start("build");
  f.settle("build");
  assert.equal(await continueAfterBackgroundBash(f.runtime, f.state), true);
  assert.equal(await continueAfterBackgroundBash(f.runtime, f.state), false);
  assert.deepEqual(f.consumed, ["build"]);
});

test("a stale lifecycle result does not resume a later execution", async () => {
  const f = fixture();
  f.start("build");
  f.settle("build");
  f.registry.update("build", (task) => ({ ...task, lifecycleId: "replacement" }));
  assert.equal(await continueAfterBackgroundBash(f.runtime, f.state), false);
  assert.deepEqual(f.consumed, []);
});

test("any completed task wakes the model without waiting for every sibling", async () => {
  const f = fixture();
  f.start("first");
  f.start("second");
  const wait = continueAfterBackgroundBash(f.runtime, f.state);
  f.settle("first");
  assert.equal(await wait, true);
  assert.equal(f.registry.get("second")?.status, "running");
  const next = continueAfterBackgroundBash(f.runtime, f.state);
  f.settle("second");
  assert.equal(await next, true);
  assert.deepEqual(f.consumed, ["first", "second"]);
});

test("preview, retained server, legacy entry, old turn and old branch do not block completion", async () => {
  const f = fixture();
  f.start("preview", { backgroundKind: "service" });
  f.start("retained", { keepAliveAfterTask: true });
  f.start("legacy", { backgroundKind: undefined });
  f.start("prior", { turnId: "turn-old" as TurnId });
  f.start("old-branch", { branchGeneration: 8 });
  assert.equal(await continueAfterBackgroundBash(f.runtime, f.state), false);
});

test("cancellation interrupts the completion wait and the normal cleanup stops the command", async () => {
  const f = fixture();
  f.start("build");
  const wait = continueAfterBackgroundBash(f.runtime, f.state);
  f.controller.abort(new Error("user stopped"));
  await assert.rejects(wait, /user stopped/);
  const stopped: string[] = [];
  f.runtime.stopBackgroundTask = async (id) => {
    stopped.push(id);
    return { ok: true, taskId: id, type: "local_bash", status: "cancelled" };
  };
  f.runtime.executionPort = {
    waitForBackgroundTask: async () => ({ result: {} }),
  } as AgentRuntimeInternal["executionPort"];
  await cleanupTurnBackgroundBash(f.runtime, f.state.turnId, f.state.turnTraceContext);
  assert.deepEqual(stopped, ["build"]);
});
