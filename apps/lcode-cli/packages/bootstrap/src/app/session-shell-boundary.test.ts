import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "@lcode/core";
import { createInMemorySessionEventStore } from "@lcode/adapters/storage";
import {
  createSessionId,
  createRootTraceContext,
  type ExecutionShellSelection,
} from "@lcode/contracts";
import { createAppSessionResume } from "./app-session-resume.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";

const selection = (name: string): ExecutionShellSelection => ({
  dialect: "posix",
  display: { name },
  path: `/shells/${name}`,
  source: "user-config",
});

test("App execution boundaries do not cache the first Host Shell response", async () => {
  const sessionId = createSessionId();
  const traceContext = createRootTraceContext({ sessionId });
  let selected = selection("A");
  const boundary = createAppSessionResume({
    startup: {
      options: {
        resolveBashShellSelection: async (trace) => {
          assert.equal(trace, traceContext);
          return selected;
        },
      },
      sessionId,
      traceContext,
    } as Parameters<typeof createAppSessionResume>[0]["startup"],
    sessionStore: {} as never,
    getRuntime: () => runtime,
  });
  const runtime = new AgentRuntime(
    sessionId,
    { mcp: { enabled: false }, subagents: { enabled: false } },
    {
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => {
        throw new Error("No model expected");
      },
      resolveSessionShellSelection: boundary.resolveSessionShellSelection,
    },
  );
  await boundary.prepareUserExecutionBoundary({ traceContext });
  assert.deepEqual(runtime.getSessionShellSelection(), selection("A"));
  selected = selection("B");
  await boundary.prepareUserExecutionBoundary({ traceContext });
  assert.deepEqual(runtime.getSessionShellSelection(), selected);
  await runtime.closeBrowserSession();
});

test("workflow child captures the parent execution Shell instead of stale startup config", async () => {
  const sessionId = createSessionId();
  const traceContext = createRootTraceContext({ sessionId });
  const runtimeConfig = {
    bashShellSelection: selection("A"),
    mcp: { enabled: false },
    subagents: { enabled: false },
  };
  let selected = selection("B");
  const parent = new AgentRuntime(sessionId, runtimeConfig, {
    eventStore: createInMemorySessionEventStore(),
    modelFactory: () => {
      throw new Error("No model expected");
    },
    resolveSessionShellSelection: async () => selected,
  });
  await parent.prepareSessionShellEnvironment(traceContext);
  const child = createScriptWorkflowAgentRuntime({
    childSessionId: createSessionId(),
    traceContext,
    request: { opts: {} } as never,
    deps: {
      runtime: parent,
      runtimeConfig,
      sessionId,
      agentTelemetry: { captureCausation: () => undefined },
      appOptions: {
        executionPort: {},
        fileSystemPort: {},
        httpClientPort: {},
        contextSourcePort: {},
      },
      fileSystemPort: {},
      configResult: { config: { network: {} } },
    } as unknown as ScriptWorkflowAgentRuntimeDeps,
  });
  assert.deepEqual(child.getSessionShellSelection(), selection("B"));
  selected = selection("C");
  await parent.prepareSessionShellEnvironment(traceContext);
  assert.deepEqual(child.getSessionShellSelection(), selection("B"));
  await Promise.all([parent.closeBrowserSession(), child.closeBrowserSession()]);
});
