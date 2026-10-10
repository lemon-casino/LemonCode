import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentRuntime, ExpertWorkflowRuntime, type WorkflowAgentRunner } from "@lcode/core";
import { createRootTraceContext, createSessionId, type FileSystemPort } from "@lcode/contracts";
import { createAppFacade } from "./app-facade.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";
import { createWorkflowFacade } from "./workflow-facade.js";

const DIRECTORY = resolve("workflow-memory-fixture");

function harness() {
  const sessionId = createSessionId("workflow-memory-parent");
  const traceContext = createRootTraceContext({ sessionId });
  const sharedPort = {
    projectMemory: { registerRoot: async () => {} },
  } as unknown as FileSystemPort;
  const optionPort = {} as FileSystemPort;
  const runtime = {
    createChildClientPorts: () => ({}),
    getSessionEventStore: () => ({}),
    getSessionModelSelection: () => undefined,
    getSessionShellSelection: () => undefined,
    getMode: () => "yolo",
    ensureSessionPersistedForExternalActivity: async () => {},
  } as unknown as AgentRuntime;
  const deps = {
    agentTelemetry: { captureCausation: () => undefined },
    appOptions: {
      executionPort: {},
      fileSystemPort: optionPort,
      contextSourcePort: {},
      httpClientPort: {},
    },
    configResult: {
      config: {
        network: {},
        ui: { locale: "en-US" },
        plugins: { enabledPlugins: {}, suppressedBuiltins: [] },
      },
    },
    fileSystemPort: sharedPort,
    runtime,
    runtimeConfig: {
      workingDirectory: DIRECTORY,
      subagents: { enabled: false },
      mcp: { enabled: false },
    },
    sessionId,
    traceContext,
    cliStorageRoot: DIRECTORY,
    storageRoot: DIRECTORY,
    workingDirectory: DIRECTORY,
    prepareUserExecutionBoundary: async () => {},
    modelFactory: () => {
      throw new Error("no real model allowed");
    },
  } as unknown as Parameters<typeof createWorkflowFacade>[0] & ScriptWorkflowAgentRuntimeDeps;
  return { deps, sharedPort, optionPort, traceContext };
}

function childPort(child: AgentRuntime): FileSystemPort | undefined {
  return (child as unknown as { fileSystemPort?: FileSystemPort }).fileSystemPort;
}

for (const withOptionPort of [true, false]) {
  test(`script/DWF child reuses the assembled fileSystemPort (option port=${withOptionPort})`, () => {
    const h = harness();
    if (!withOptionPort) delete h.deps.appOptions.fileSystemPort;
    const child = createScriptWorkflowAgentRuntime({
      childSessionId: createSessionId("workflow-memory-child"),
      deps: h.deps,
      request: { opts: {} } as never,
      traceContext: h.traceContext,
    });
    assert.equal(childPort(child), h.sharedPort);
    assert.equal(childPort(child)?.projectMemory, h.sharedPort.projectMemory);
  });
}

function interceptLegacyChild(t: TestContext) {
  const ports: Array<FileSystemPort | undefined> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const closed: AgentRuntime[] = [];
  t.mock.method(
    AgentRuntime.prototype,
    "executeTurn",
    async function (
      this: AgentRuntime,
      _input: unknown,
      _attachments: unknown,
      options: { abortSignal?: AbortSignal },
    ) {
      ports.push(childPort(this));
      signals.push(options.abortSignal);
      return { response: "fixture", traceId: "trace-fixture", turnId: "turn-fixture" };
    },
  );
  t.mock.method(AgentRuntime.prototype, "closeBrowserSession", async function (this: AgentRuntime) {
    closed.push(this);
  });
  // Only replace the disk-backed workflow scheduler; run the real facade-to-child wiring.
  t.mock.method(
    ExpertWorkflowRuntime.prototype,
    "start",
    async function (this: ExpertWorkflowRuntime, options: { abortSignal?: AbortSignal }) {
      const { agentRunner } = (this as unknown as { ctx: { agentRunner: WorkflowAgentRunner } })
        .ctx;
      return agentRunner.run({
        activityId: "memory-wiring-activity",
        runId: "memory-wiring-run",
        phase: "planner",
        prompt: "fixture",
        abortSignal: options.abortSignal,
      } as Parameters<WorkflowAgentRunner["run"]>[0]);
    },
  );
  return { ports, signals, closed };
}

test("legacy workflow prefers the assembled port and keeps cancellation/cleanup wiring", async (t) => {
  const h = harness();
  const observed = interceptLegacyChild(t);
  const controller = new AbortController();
  const facade = createWorkflowFacade(h.deps);
  await facade.runWorkflow!({ task: "fixture" }, { abortSignal: controller.signal });
  assert.deepEqual(observed.ports, [h.sharedPort]);
  assert.deepEqual(observed.signals, [controller.signal]);
  assert.equal(observed.closed.length, 1);
});

test("legacy workflow keeps appOptions and default adapter fallback for old callers", async (t) => {
  const h = harness();
  const observed = interceptLegacyChild(t);
  const { fileSystemPort: _shared, ...legacyDeps } = h.deps;
  await createWorkflowFacade(legacyDeps).runWorkflow!({ task: "fixture" });
  assert.equal(observed.ports[0], h.optionPort);
  delete legacyDeps.appOptions.fileSystemPort;
  await createWorkflowFacade(legacyDeps).runWorkflow!({ task: "fixture" });
  assert.equal(typeof observed.ports[1]?.readTextFile, "function");
  assert.equal(typeof observed.ports[1]?.writeTextFile, "function");
});

test("app facade forwards the assembled port rather than making workflow reconstruct it", async (t) => {
  const h = harness();
  const observed = interceptLegacyChild(t);
  const app = createAppFacade({
    startup: {
      ...h.deps,
      options: h.deps.appOptions,
      modelTelemetry: { agentExecution: h.deps.agentTelemetry },
    },
    configuration: {
      ...h.deps,
      configuredMcpServers: {},
      untrustedProjectMcpServers: {},
    },
    adapters: { fileSystemPort: h.sharedPort },
    runtime: h.deps.runtime,
    getRuntime: () => h.deps.runtime,
    providerModelRuntime: {},
    modelAdapter: {},
    modelFactory: h.deps.modelFactory,
    resumeBoundary: { prepareUserExecutionBoundary: async () => {} },
    scriptWorkflowFacade: {},
  } as unknown as Parameters<typeof createAppFacade>[0]);
  await app.runWorkflow!({ task: "fixture" });
  assert.deepEqual(observed.ports, [h.sharedPort]);
});
