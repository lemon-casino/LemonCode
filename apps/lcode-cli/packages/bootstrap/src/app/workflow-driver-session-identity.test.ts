import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntime } from "@lcode/core";
import {
  InMemoryJournalStore,
  WorkflowError,
  type ActorRef,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import { mintActorSessionId, resolveActorSessionId } from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";

const actor: ActorRef = { siteId: "actor#reader", ordinal: 1 };

const sink: WorkflowReportSink = {
  askSubmitAttempted: () => {},
  askTurnEnded: () => {},
  askProgress: () => {},
  askActivity: () => {},
  askStats: () => {},
  askFailed: () => {},
  stopRun: () => {},
  runStalled: () => {},
  askWaiting: () => {},
  askExecuting: () => {},
  askMutating: () => {},
  concurrencyChanged: () => {},
};

test("fresh and matching journal identities use the same run-scoped session id", () => {
  const expected = mintActorSessionId("identity-run", actor);
  assert.equal(resolveActorSessionId("identity-run", actor, undefined), expected);
  assert.equal(resolveActorSessionId("identity-run", actor, expected), expected);
  assert.notEqual(resolveActorSessionId("other-run", actor, undefined), expected);
  assert.notEqual(
    resolveActorSessionId("identity-run", { ...actor, ordinal: 2 }, undefined),
    expected,
  );
});

test("a conflicting journal identity preserves the structured DriverError", () => {
  const actual = mintActorSessionId("identity-run", actor);
  for (const recorded of ["other-session", ""]) {
    assert.throws(
      () => resolveActorSessionId("identity-run", actor, recorded),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, "DriverError");
        assert.equal(
          error.message,
          "Subagent session identity mismatch for actor#reader@1: the journaled session id and the minted one differ.",
        );
        assert.deepEqual(error.mismatch, { expected: recorded, got: actual });
        return true;
      },
    );
  }
});

for (const recorded of [undefined, "matching", "conflicting"] as const) {
  test(`production driver ${recorded ?? "fresh"} identity checks precede runtime construction`, async () => {
    const journal = new InMemoryJournalStore();
    const runId = "identity-run";
    const expected = mintActorSessionId(runId, actor);
    journal.createRun({ runId, status: "running", caps: { maxConcurrency: 1 }, spentTokens: 0 });
    if (recorded !== undefined) {
      journal.putActor({
        runId,
        ...actor,
        sessionId: recorded === "matching" ? expected : "other-session",
      });
    }
    let factoryCalls = 0;
    const deps = {
      runId,
      journal,
      emit: () => {},
      runtimeFactory: ({ sessionId }: { sessionId: string }) => {
        factoryCalls++;
        assert.equal(sessionId, expected);
        return { closeBrowserSession: async () => {} } as unknown as AgentRuntime;
      },
    } as unknown as AgentRuntimeWorkflowDriverDeps;
    const driver = createAgentRuntimeWorkflowDriver(deps)(sink);
    try {
      if (recorded === "conflicting") {
        await assert.rejects(driver.createActorSession(actor, {}), { code: "DriverError" });
        assert.equal(factoryCalls, 0);
      } else {
        assert.deepEqual(await driver.createActorSession(actor, {}), { id: expected });
        assert.equal(factoryCalls, 1);
      }
    } finally {
      driver.dispose?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}
