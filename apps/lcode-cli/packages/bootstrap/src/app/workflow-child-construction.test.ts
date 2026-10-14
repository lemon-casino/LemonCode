import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  createRootTraceContext,
  createInMemorySessionEventStore,
} from "@lcode/contracts";
import { AgentRuntime } from "@lcode/core";
import { browserFixture } from "../lcode-protocol/browser-control-broker.fixture.js";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";

test("workflow constructor exceptions roll back provisional Browser scope before same-ID retry", async () => {
  const { port, sessions } = browserFixture();
  const parentId = createSessionId("root");
  const childId = createSessionId("constructor-child");
  sessions.set(parentId, sessions.get("root")!);
  const config = {
    workingDirectory: "fixture",
    runtimeFeatures: { browserUse: true },
    subagents: { enabled: false },
    mcp: { enabled: false },
  };
  const parent = new AgentRuntime(parentId, config, {
    browserControlPort: port,
    eventStore: createInMemorySessionEventStore(),
    modelFactory: () => {
      throw new Error("No model request expected");
    },
  });
  const deps = {
    agentTelemetry: { captureCausation: () => undefined },
    appOptions: { executionPort: {} },
    configResult: { config: { network: {} } },
    runtime: parent,
    runtimeConfig: config,
    sessionId: parentId,
    workingDirectory: "fixture",
    storageRoot: "fixture",
    fileSystemPort: {},
    logger: {
      child: () => {
        throw new Error("fixture constructor failure");
      },
    },
  } as unknown as ScriptWorkflowAgentRuntimeDeps;
  try {
    assert.throws(
      () =>
        createScriptWorkflowAgentRuntime({
          childSessionId: childId,
          deps,
          request: { opts: {} } as never,
          traceContext: createRootTraceContext(),
        }),
      /fixture constructor failure/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(port.list({ sessionId: childId }), /not active/);
    const replacement = port.createChildScope!({ parentSessionId: parentId, sessionId: childId });
    await replacement.list({ sessionId: childId });
    await replacement.closeSession!({ sessionId: childId });
  } finally {
    await port.closeSession!({ sessionId: childId });
    await parent.closeBrowserSession();
  }
});
