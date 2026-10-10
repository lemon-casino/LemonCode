import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent, TraceContext } from "@lcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  runGoalVerifierBoundary,
  commitVerifiedGoalCompletion,
} from "./target-completion-commit.js";
import { verifyActiveTargetCompletionForContinuation } from "./target-completion-verification.js";
import { evidenceFixture } from "../../goal/evidence.fixture.js";

test("strict initialization failures persist incomplete; legacy errors retain their existing exception path", async () => {
  const fixture = evidenceFixture();
  const events: SessionEvent[] = [];
  const runtime = {
    rebuildProjection: async () => ({ targetCompletionVerificationTimeline: [] }),
    createEvent: (type: SessionEvent["type"], payload: unknown) => ({ type, payload }),
    appendEvent: async (event: SessionEvent) => {
      events.push(event);
    },
  } as unknown as AgentRuntimeInternal;
  const input = { target: fixture.goal, traceContext: { traceId: "trace" } as TraceContext };
  const decision = await runGoalVerifierBoundary(runtime, input, async () => {
    throw new Error("model factory unavailable");
  });
  assert.equal(decision.passed, false);
  assert.equal(decision.nextAction, undefined);
  assert.deepEqual(
    events.map((event) => (event.payload as { status: string }).status),
    ["started", "failed_closed"],
  );
  await assert.rejects(
    runGoalVerifierBoundary(
      runtime,
      { ...input, target: { ...fixture.goal, acceptance: undefined } },
      async () => {
        throw new Error("legacy error");
      },
    ),
    /legacy error/,
  );
});
test("strict completion rejects late branches, changed goal, incomplete evidence and cancelled verification", async () => {
  const fixture = evidenceFixture();
  let writes = 0;
  const runtime = {
    sessionId: fixture.owner.sessionId,
    workingDirectory: fixture.owner.workspacePath,
    config: { workspaceIdentity: fixture.owner.workspaceKey },
    fileSystemPort: fixture.owner.fileSystem,
    sessionStore: {
      ...fixture.owner.store,
      updateTargetStatus: async () => {
        writes++;
        return fixture.goal;
      },
    },
    branchGeneration: 2,
    readSessionTargetForContext: async () => fixture.goal,
    rebuildProjection: async () => ({ targetCompletionVerificationTimeline: [] }),
  } as unknown as AgentRuntimeInternal;
  const result = await commitVerifiedGoalCompletion(
    runtime,
    { target: fixture.goal, traceContext: {} as TraceContext, generation: 1 },
    { passed: true, reason: "model claimed done" },
  );
  assert.equal(result.verification.passed, false);
  assert.equal(writes, 0);
  const current = await commitVerifiedGoalCompletion(
    runtime,
    { target: fixture.goal, traceContext: {} as TraceContext, generation: 2 },
    { passed: true, reason: "missing real check" },
  );
  assert.equal(current.verification.passed, false);
  assert.equal(writes, 0);
});

test("strict goal cannot bypass verifier via enabled=false and missing model configuration persists an incomplete attempt", async () => {
  const fixture = evidenceFixture();
  const events: SessionEvent[] = [];
  const scope = {
    run: async (execute: () => Promise<unknown>) => execute(),
    setResultType: () => {},
    finishCompleted: () => {},
    finishFailed: () => {},
    finishCancelled: () => {},
  };
  const runtime = {
    config: { targetCompletionVerification: { enabled: false } },
    sessionStore: fixture.owner.store,
    getSessionModelSelection: () => undefined,
    agentTelemetry: { detached: () => scope },
    rebuildProjection: async () => ({ targetCompletionVerificationTimeline: [] }),
    createEvent: (type: SessionEvent["type"], payload: unknown) => ({ type, payload }),
    appendEvent: async (event: SessionEvent) => {
      events.push(event);
    },
  } as unknown as AgentRuntimeInternal;
  const result = await verifyActiveTargetCompletionForContinuation.call(runtime, {
    target: fixture.goal,
    traceContext: { traceId: "strict" } as TraceContext,
  });
  assert.equal(result?.verification.passed, false);
  assert.equal(result?.verification.nextAction, undefined);
  const terminal = events.at(-1);
  assert.ok(terminal);
  assert.equal((terminal.payload as { status: string }).status, "failed_closed");
  const legacy = await verifyActiveTargetCompletionForContinuation.call(runtime, {
    target: { ...fixture.goal, acceptance: undefined },
    traceContext: {} as TraceContext,
  });
  assert.equal(legacy, null);
});
