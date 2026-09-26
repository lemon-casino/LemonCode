import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DynamicWorkflowRunAmendRequest, DynamicWorkflowRunPort } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { amendWorkflowRunSettings } from "./dynamic-workflow-run-settings.js";

test("GUI settings revision inherits predecessor actor model overrides", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-workflow-settings-"));
  const script = 'const writer = agent("writer");\nreturn await writer.ask("Draft it");';
  const actorModelOverrides = [
    {
      name: "writer",
      selection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high", speed: "fast" },
      },
    },
  ] as const;
  let submitted: DynamicWorkflowRunAmendRequest | undefined;
  const port = {
    concurrencyCeiling: () => 4,
    getTask: async () => ({
      runId: "run-1",
      taskId: "run-1",
      startedAt: new Date(0),
      status: "running",
      runStatus: "running",
      parentSessionId: "session-1",
      maxConcurrency: 2,
      actorModelOverrides,
    }),
    getScript: async () => script,
    amend: async (request: DynamicWorkflowRunAmendRequest) => {
      submitted = request;
      return { ok: true as const, runId: "run-2", supersededRunId: "run-1" };
    },
  } as DynamicWorkflowRunPort;
  const runtime = {
    branchGeneration: 0,
    dynamicWorkflowRunPort: port,
    enqueueRuntimeCommand: () => undefined,
    executor: { trackExternalBackgroundTask: async () => undefined },
    rootTraceContext: { traceId: "trace-1" },
    sessionId: "session-1",
    workingDirectory: cwd,
  } as unknown as AgentRuntimeInternal;

  try {
    const result = await amendWorkflowRunSettings.call(runtime, {
      runId: "run-1",
      maxConcurrency: 1,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(submitted?.actorModelOverrides, actorModelOverrides);
  } finally {
    assert.ok(cwd.startsWith(join(tmpdir(), "zcode-workflow-settings-")));
    await rm(cwd, { recursive: true, force: true });
  }
});
