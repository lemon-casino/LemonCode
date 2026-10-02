import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createFileSystemError,
  createRootTraceContext,
  type FileSystemPort,
} from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import {
  createConfigOnlyContextSnapshot,
  ensureContextInitialized,
  loadProjectMemoryRoot,
} from "./context.js";
import { resumeFromStore } from "./resume.js";

function harness() {
  const calls: Array<{ kind: string; path: string }> = [];
  const fileSystemPort = {
    createDirectory: async ({ path }: { path: string }) => {
      calls.push({ kind: "ensure", path });
      return { path };
    },
    projectMemory: {
      registerRoot: async (path: string) => {
        calls.push({ kind: "register", path });
      },
    },
    readTextFile: async () => {
      throw createFileSystemError({ code: "not_found", message: "fixture missing" });
    },
  } as unknown as FileSystemPort;
  const runtime = {
    config: { memory: { enabled: true, cliStorageRoot: resolve("context-storage-fixture") } },
    workingDirectory: resolve("context-workspace-fixture"),
    workspaceRoot: resolve("context-workspace-fixture"),
    // profile memory 不属于 Project Memory，不能依据这个现有字段登记根。
    memoryRoot: resolve("profile-memory-fixture"),
    fileSystemPort,
    readFileState: new Map(),
    sessionId: "session-context-fixture",
    rootTraceContext: createRootTraceContext(),
    now: () => new Date(0),
    logMemorySkipped() {},
    startMcpStartup() {},
    discoverSkillsForContext: async () => undefined,
    loadProjectMemoryRoot,
    ensureContextInitialized,
    createConfigOnlyContextSnapshot,
    createContextBuilderFromSnapshot: () => ({}),
    initializeMessageHistoryFromContext() {},
  } as unknown as AgentRuntimeInternal;
  return { calls, runtime, fileSystemPort };
}

test("context registers the resolved project root after ensure and only once per initialization", async () => {
  const h = harness();
  const expectedRoot = resolveEnabledProjectMemoryRoot(h.runtime.config, h.runtime.workspaceRoot)!;
  await h.runtime.ensureContextInitialized(h.runtime.rootTraceContext);
  await h.runtime.ensureContextInitialized(h.runtime.rootTraceContext);
  assert.equal(h.runtime.memoryRoot, expectedRoot);
  assert.deepEqual(h.calls, [
    { kind: "ensure", path: expectedRoot },
    { kind: "register", path: expectedRoot },
  ]);
});

test("cold resume reuses context initialization and registers the persisted workspace identity", async () => {
  const h = harness();
  await h.runtime.ensureContextInitialized(h.runtime.rootTraceContext);
  const originalRoot = h.runtime.memoryRoot;
  const resumedDirectory = resolve("resumed-workspace-fixture");
  let resumeHooks = 0;
  Object.assign(h.runtime, {
    sessionStore: {
      getSession: async () => ({
        directory: resumedDirectory,
        workspaceID: "workspace-resumed-fixture",
        taskType: "interactive",
        title: "",
        time: {},
      }),
      messages: async () => [],
    },
    runtimeTaskRegistry: {},
    eventStore: { getEvents: async () => [] },
    executionFailoverPolicyPort: { reset: async () => {} },
    recoverInterruptedCompactTimelines: async () => 0,
    discardPersistedPendingSteerInputs: async () => {},
    readSessionTodosForContext: async () => [],
    readSessionTargetForContext: async () => undefined,
    injectTargetStateIntoMessageHistory() {},
    createEvent: () => ({}),
    appendEvent: async () => {},
    runSessionStartHooks: async () => {
      resumeHooks += 1;
      return { additionalContexts: [] };
    },
    injectHookAdditionalContextIntoMessageHistory() {},
  });
  await resumeFromStore.call(h.runtime);
  const expectedRoot = resolveEnabledProjectMemoryRoot(h.runtime.config, resumedDirectory)!;
  assert.notEqual(expectedRoot, originalRoot);
  assert.equal(h.runtime.memoryRoot, expectedRoot);
  assert.deepEqual(h.calls.slice(-2), [
    { kind: "ensure", path: expectedRoot },
    { kind: "register", path: expectedRoot },
  ]);
  assert.equal(h.calls.length, 4);
  assert.equal(resumeHooks, 1, "existing main-session resume hook remains intact");
});

test("a profile memory root on a subagent never registers as Project Memory", async () => {
  const h = harness();
  h.runtime.config.taskType = "subagent_child";
  assert.equal(await loadProjectMemoryRoot.call(h.runtime, h.runtime.rootTraceContext), undefined);
  assert.deepEqual(h.calls, []);
});

test("ports without projectMemory capability retain the legacy initialization path", async () => {
  const h = harness();
  delete h.fileSystemPort.projectMemory;
  assert.ok(await loadProjectMemoryRoot.call(h.runtime, h.runtime.rootTraceContext));
  assert.deepEqual(
    h.calls.map((call) => call.kind),
    ["ensure"],
  );
});

test("registration failure does not expose an ungoverned project root", async () => {
  const h = harness();
  const error = new Error("fixture registration rejected");
  h.fileSystemPort.projectMemory!.registerRoot = async () => {
    throw error;
  };
  await assert.rejects(
    h.runtime.ensureContextInitialized(h.runtime.rootTraceContext),
    (cause) => cause === error,
  );
  assert.notEqual(h.runtime.contextInitialized, true);
});
