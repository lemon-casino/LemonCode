import assert from "node:assert/strict";
import test from "node:test";
import type { TaskOutputResult } from "@lcode/contracts";
import { TASK_OUTPUT_PROVIDER_DESCRIPTION } from "@lcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { ToolExecutionContext } from "../types.js";
import { agentToolEntry } from "./agent.js";
import { taskOutputToolEntry } from "./task-output.js";

const AGENT_ID = "agent-example";

function registerAgent(status: RuntimeTaskSnapshot["status"] = "running") {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register({
    taskId: AGENT_ID,
    agentId: AGENT_ID,
    agentType: "Explore",
    description: "Inspect the workspace",
    status,
    startedAt: new Date(),
    type: "local_agent",
    isBackgrounded: true,
    ...(status === "completed"
      ? {
          output: {
            status: "completed" as const,
            agentId: AGENT_ID,
            agentType: "Explore",
            description: "Inspect the workspace",
            prompt: "Inspect",
            content: [{ type: "text" as const, text: "Done" }],
            totalToolUseCount: 1,
            totalDurationMs: 100,
          },
        }
      : {}),
  });
  return registry;
}

function context(registry: InMemoryRuntimeTaskRegistry, signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    runtimeTaskRegistry: registry,
    sessionId: "session-example",
    toolCallId: "call-example",
    traceId: "trace-example",
    workingDirectory: ".",
    workspaceRoot: ".",
  } as ToolExecutionContext;
}

test("background Agent guidance uses completion notifications without TaskOutput polling", () => {
  const description = agentToolEntry.metadata.description ?? "";
  const launch = agentToolEntry.formatModelContent?.({
    status: "async_launched",
    isAsync: true,
    agentId: AGENT_ID,
    agentType: "Explore",
    description: "Inspect the workspace",
    prompt: "Inspect",
    childSessionId: "child-example",
    backgroundTaskId: AGENT_ID,
    outputFile: "agent.output",
    canReadOutputFile: true,
  });

  assert.match(description, /Do not (?:wait for|poll).*TaskOutput/u);
  assert.match(String(launch), /Do not (?:wait for|poll).*TaskOutput/u);
  assert.doesNotMatch(String(launch), /output_file:/u);
  assert.match(TASK_OUTPUT_PROVIDER_DESCRIPTION, /local_agent.*do not.*TaskOutput/iu);
  assert.doesNotMatch(TASK_OUTPUT_PROVIDER_DESCRIPTION, /Works with all task types/iu);
});

test("TaskOutput immediately returns not_ready for a running background agent", async () => {
  const registry = registerAgent();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 100);
  try {
    const result = (await taskOutputToolEntry.handler(
      { task_id: AGENT_ID, block: true, timeout: 120_000 },
      context(registry, controller.signal),
    )) as TaskOutputResult;

    assert.equal(result.retrieval_status, "not_ready");
    assert.equal(result.task?.status, "running");
    assert.equal(result.task?.output, "");
    assert.equal(registry.get(AGENT_ID)?.notified, undefined);
    assert.match(
      String(taskOutputToolEntry.formatModelContent?.(result)),
      /Do not call TaskOutput again/u,
    );
  } finally {
    clearTimeout(timeout);
  }
});

test("TaskOutput snapshot of a completed background agent does not suppress notification", async () => {
  const registry = registerAgent("completed");
  const result = (await taskOutputToolEntry.handler(
    { task_id: AGENT_ID, block: false, timeout: 0 },
    context(registry),
  )) as TaskOutputResult;

  assert.equal(result.retrieval_status, "success");
  assert.equal(result.task?.output, "Done");
  assert.equal(registry.get(AGENT_ID)?.notified, undefined);
});

test("TaskOutput keeps blocking semantics for other background task types", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register({
    taskId: "bash-example",
    agentId: "bash-example",
    agentType: "Bash",
    description: "Run a command",
    status: "running",
    startedAt: new Date(),
    type: "local_bash",
    isBackgrounded: true,
  });
  const result = (await taskOutputToolEntry.handler(
    { task_id: "bash-example", block: true, timeout: 0 },
    context(registry),
  )) as TaskOutputResult;

  assert.equal(result.retrieval_status, "timeout");
  assert.equal(result.task?.task_type, "local_bash");
});
