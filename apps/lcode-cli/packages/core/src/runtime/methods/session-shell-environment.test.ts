import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionShellSelection, SessionStorePort } from "../deps.js";
import { createMockRuntime } from "./lint-runtime-fixture.js";
import type { RuntimeCommandId } from "../command-queue.js";
import {
  refreshSessionShellEnvironmentForExecution,
  restoreSessionShellEnvironmentSelectionForResume,
} from "./session-shell-environment.js";
import { announceSessionShellEnvironmentNoticeAfterResume } from "./session-shell-environment.js";

function shell(name: string, path = `/shells/${name}`): ExecutionShellSelection {
  return { dialect: "posix", display: { name }, path, source: "user-config" };
}

test("idle execution refreshes the shell and announces A -> B -> A including same-name paths", async () => {
  const { runtime } = createMockRuntime({ bashShellSelection: shell("A") });
  runtime.contextInitialized = true;
  let selected = shell("B");
  const saved: unknown[] = [];
  runtime.sessionPersisted = true;
  runtime.sessionStore = {
    saveSessionEntry: async (entry) => {
      saved.push(entry.data);
    },
  } as unknown as SessionStorePort;
  runtime.resolveSessionShellSelection = async () => selected;
  for (const next of [shell("B"), shell("A"), shell("A", "/other/A")]) {
    selected = next;
    assert.equal(await runtime.prepareSessionShellEnvironment(runtime.rootTraceContext), true);
    assert.deepEqual(runtime.getSessionShellSelection(), next);
  }
  assert.equal(saved.length, 3);
  const notices = runtime.messageHistory
    .borrowReadOnlyRuntimeEntries()
    .filter((entry) => entry.metadata?.source === "shell_environment_change");
  assert.equal(notices.length, 3);
  assert.match(JSON.stringify(notices.at(-1)), /\/other\/A/);
  assert.equal(await runtime.prepareSessionShellEnvironment(runtime.rootTraceContext), false);
  assert.equal(saved.length, 3);
});

test("running task keeps A, while a queued next task reads the latest C at execution", async () => {
  const running = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const observed: string[] = [];
  let selected = shell("A");
  let reads = 0;
  const { runtime } = createMockRuntime({}, async function* () {
    observed.push(runtime.getSessionShellSelection()!.display.name);
    if (observed.length === 1) {
      running.resolve();
      await release.promise;
      assert.equal(runtime.getSessionShellSelection()!.display.name, "A");
    }
    yield { type: "finish", finishReason: "stop", usage: {} };
  });
  runtime.resolveSessionShellSelection = async () => {
    reads += 1;
    return selected;
  };
  const first = runtime.executeTurn("first task");
  await running.promise;
  selected = shell("B");
  assert.equal(await runtime.prepareSessionShellEnvironment(runtime.rootTraceContext), false);
  assert.equal(reads, 1);
  const next = runtime.executeTurn("queued task");
  selected = shell("C");
  release.resolve();
  await Promise.all([first, next]);
  assert.deepEqual(observed, ["A", "C"]);
  assert.equal(reads, 2);
});

test("cold resume uses current shell instead of the persisted creation snapshot", async () => {
  const old = shell("A", process.execPath);
  const current = shell("B");
  const { runtime } = createMockRuntime({ bashShellSelection: current });
  const saved: unknown[] = [];
  runtime.sessionStore = {
    sessionEntries: async () => [{ data: old }],
    saveSessionEntry: async (entry) => {
      saved.push(entry.data);
    },
  } as unknown as SessionStorePort;
  const restore = await restoreSessionShellEnvironmentSelectionForResume(runtime, {
    currentSelection: current,
    traceContext: runtime.rootTraceContext,
  });
  assert.equal(restore.status, "refreshed");
  assert.deepEqual(runtime.getSessionShellSelection(), current);
  assert.deepEqual(saved, [current]);
  announceSessionShellEnvironmentNoticeAfterResume(runtime, {
    persistedEnvInfo: undefined,
    restore,
  });
  assert.match(
    JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries()),
    /changed to B/,
  );
});

test("a failed Shell read releases prompt admission so the next task can start", async () => {
  const { runtime } = createMockRuntime({ bashShellSelection: shell("A") });
  const drain = runtime.drainRuntimeCommandQueue.bind(runtime);
  let draining: Promise<void> | undefined;
  runtime.drainRuntimeCommandQueue = () => {
    draining = drain();
    return draining;
  };
  runtime.resolveSessionShellSelection = async () => {
    throw new Error("Host unavailable");
  };
  const admitted = await runtime.admitPrompt("failed task");
  assert.equal(admitted.kind, "started");
  if (admitted.kind !== "started") throw new Error("Expected admitted prompt");
  await assert.rejects(admitted.completion, /Host unavailable/);
  // completion 早于 foreground 最终收尾；等待真实 drain，不能用延时模拟 owner 释放。
  await draining;
  assert.equal(runtime.activeTurnStartReservation, undefined);
  runtime.resolveSessionShellSelection = async () => shell("B");
  const next = await runtime.admitPrompt("retry task");
  assert.equal(next.kind, "started");
  if (next.kind !== "started") throw new Error("Expected retry prompt");
  await next.completion;
  assert.equal(runtime.getSessionShellSelection()!.display.name, "B");
});

test("refresh keeps existing conversation while updating the model Environment prefix", async () => {
  const { runtime } = createMockRuntime({ bashShellSelection: shell("A") });
  runtime.contextSourceSnapshot = runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(runtime.contextSourceSnapshot);
  runtime.initializeMessageHistoryFromContext(runtime.contextBuilder, runtime.rootTraceContext);
  runtime.contextInitialized = true;
  runtime.messageHistory.addUser("retained conversation");
  runtime.resolveSessionShellSelection = async () => shell("B");
  await runtime.prepareSessionShellEnvironment(runtime.rootTraceContext);
  assert.equal(runtime.config.envInfo?.shell, "B");
  assert.equal(runtime.contextSourceSnapshot.envInfo.shell, "B");
  const messages = JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  assert.match(messages, /Shell: B/);
  assert.match(messages, /retained conversation/);
});

test("a newer idle read supersedes an old result even when the newer Shell is unchanged", async () => {
  const { runtime } = createMockRuntime({ bashShellSelection: shell("A") });
  const pending = Promise.withResolvers<ExecutionShellSelection>();
  runtime.resolveSessionShellSelection = () => pending.promise;
  const first = runtime.prepareSessionShellEnvironment(runtime.rootTraceContext);
  const rejected = assert.rejects(first);
  runtime.resolveSessionShellSelection = async () => shell("A");
  assert.equal(await runtime.prepareSessionShellEnvironment(runtime.rootTraceContext), false);
  pending.resolve(shell("B"));
  await rejected;
  assert.equal(runtime.getSessionShellSelection()!.display.name, "A");
});

test("cancelling a running task allows the next task to use the changed Shell", async () => {
  const controller = new AbortController();
  let selected = shell("A");
  let calls = 0;
  const { runtime } = createMockRuntime({}, async function* () {
    calls += 1;
    if (calls === 1) {
      selected = shell("B");
      assert.equal(runtime.getSessionShellSelection()!.display.name, "A");
      controller.abort(new Error("cancel fixture"));
      throw controller.signal.reason;
    }
    yield { type: "finish", finishReason: "stop", usage: {} };
  });
  runtime.resolveSessionShellSelection = async () => selected;
  await assert.rejects(
    runtime.executeTurn("cancel task", undefined, { abortSignal: controller.signal }),
  );
  await runtime.executeTurn("next task");
  assert.equal(runtime.getSessionShellSelection()!.display.name, "B");
});

test("cancellation during a Shell read leaves no reservation or cancel receipt", async () => {
  const { runtime } = createMockRuntime({ bashShellSelection: shell("A") });
  const pending = Promise.withResolvers<ExecutionShellSelection>();
  const controller = new AbortController();
  const drain = runtime.drainRuntimeCommandQueue.bind(runtime);
  let draining: Promise<void> | undefined;
  runtime.drainRuntimeCommandQueue = () => {
    draining = drain();
    return draining;
  };
  runtime.resolveSessionShellSelection = () => pending.promise;
  const admitted = await runtime.admitPrompt("cancel startup", undefined, {
    abortSignal: controller.signal,
  });
  if (admitted.kind !== "started") throw new Error("Expected admitted prompt");
  const commandId = runtime.activeForegroundExecution!.foregroundExecutionId as RuntimeCommandId;
  const rejected = assert.rejects(admitted.completion);
  controller.abort();
  pending.resolve(shell("B"));
  await rejected;
  await draining;
  assert.equal(runtime.activeTurnStartReservation, undefined);
  assert.equal(runtime.runtimeCommandQueue.consumeCancelPending(commandId), false);
  assert.equal(runtime.getSessionShellSelection()!.display.name, "A");
});

test("cold resume without a current candidate retains a usable persisted Shell", async () => {
  const old = shell("A", process.execPath);
  const { runtime } = createMockRuntime();
  runtime.sessionStore = {
    sessionEntries: async () => [{ data: old }],
  } as unknown as SessionStorePort;
  const restore = await restoreSessionShellEnvironmentSelectionForResume(runtime, {
    currentSelection: undefined,
    traceContext: runtime.rootTraceContext,
  });
  assert.equal(restore.status, "restored");
  assert.deepEqual(runtime.getSessionShellSelection(), old);
});

test("failed preference reads and stale or cancelled results cannot overwrite the shell", async () => {
  const old = shell("A");
  const { runtime } = createMockRuntime({ bashShellSelection: old });
  runtime.resolveSessionShellSelection = async () => {
    throw new Error("Host unavailable");
  };
  await assert.rejects(
    runtime.prepareSessionShellEnvironment(runtime.rootTraceContext),
    /Host unavailable/,
  );
  assert.deepEqual(runtime.getSessionShellSelection(), old);
  const pending = Promise.withResolvers<ExecutionShellSelection>();
  runtime.resolveSessionShellSelection = () => pending.promise;
  const refresh = runtime.prepareSessionShellEnvironment(runtime.rootTraceContext);
  runtime.branchGeneration += 1;
  pending.resolve(shell("B"));
  await assert.rejects(refresh);
  assert.deepEqual(runtime.getSessionShellSelection(), old);
  const controller = new AbortController();
  runtime.resolveSessionShellSelection = async () => {
    controller.abort();
    return shell("C");
  };
  await assert.rejects(
    refreshSessionShellEnvironmentForExecution(
      runtime,
      runtime.rootTraceContext,
      controller.signal,
    ),
  );
  assert.deepEqual(runtime.getSessionShellSelection(), old);
});
