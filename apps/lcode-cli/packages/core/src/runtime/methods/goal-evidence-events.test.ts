import assert from "node:assert/strict";
import test from "node:test";
import { type SessionEvent, type TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ToolExecutorDeps } from "../../tool/executor/types.js";
import { emitToolCallStarted, emitToolCallResult } from "../../tool/executor/events.js";
import { observeGoalToolEvent } from "./goal-evidence-events.js";
import { evidenceFixture } from "../../goal/evidence.fixture.js";
import { readGoalEvidenceSummary } from "../../goal/evidence.js";

test("executor raw Bash facts pass even when serialized text is not JSON; prose alone cannot create a passed receipt", async () => {
  for (const realFacts of [true, false]) {
    const fixture = evidenceFixture();
    const runtime = {
      sessionId: fixture.owner.sessionId,
      workingDirectory: fixture.owner.workspacePath,
      config: { workspaceIdentity: fixture.owner.workspaceKey },
      fileSystemPort: fixture.owner.fileSystem,
      sessionStore: fixture.owner.store,
      branchGeneration: 0,
    } as unknown as AgentRuntimeInternal;
    const deps = {
      sessionId: fixture.owner.sessionId,
      emitEvent: (event: SessionEvent) => observeGoalToolEvent(runtime, event),
    } as ToolExecutorDeps;
    const tool = { id: "actual-call", name: "Bash", input: { command: "pnpm test" } } as never;
    await emitToolCallStarted(deps, tool, {} as TraceContext, undefined, 10);
    await emitToolCallResult(
      deps,
      tool,
      {} as TraceContext,
      undefined,
      { content: "tests passed, exitCode=0", truncated: false } as never,
      1,
      undefined,
      undefined,
      undefined,
      realFacts
        ? { stdout: "real test output", stderr: "", exitCode: 0, interrupted: false }
        : undefined,
    );
    const summary = await readGoalEvidenceSummary(fixture.owner, fixture.goal);
    assert.equal(summary?.requirements[0]?.status, realFacts ? "passed" : "unknown");
  }
});
test("branch changes between actual start and terminal settlement discard evidence", async () => {
  const fixture = evidenceFixture();
  const runtime = {
    sessionId: fixture.owner.sessionId,
    workingDirectory: fixture.owner.workspacePath,
    config: { workspaceIdentity: fixture.owner.workspaceKey },
    fileSystemPort: fixture.owner.fileSystem,
    sessionStore: fixture.owner.store,
    branchGeneration: 0,
  } as unknown as AgentRuntimeInternal;
  await observeGoalToolEvent(runtime, {
    type: "tool_call_started",
    timestamp: new Date(10),
    payload: { toolCallId: "call", toolName: "Bash", executionCommand: "pnpm test" },
  } as SessionEvent);
  runtime.branchGeneration = 1;
  await observeGoalToolEvent(runtime, {
    type: "tool_call_result",
    timestamp: new Date(20),
    payload: {
      toolCallId: "call",
      result: {
        executionFacts: {
          exitCode: 0,
          output: { sha256: "a".repeat(64), bytes: 1, truncated: false, artifactRefs: [] },
        },
      },
    },
  } as SessionEvent);
  assert.equal([...fixture.entries.values()].filter((entry) => entry.type === "goal/evidence/v1").length, 0);
  assert.equal((await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.outcome, "incomplete");
});
