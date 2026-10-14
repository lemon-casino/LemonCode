import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJournalStore, type WorkflowReportSink } from "@lcode/dynamic-workflow";
import type { AgentRuntime } from "@lcode/core";
import { browserFixture } from "../lcode-protocol/browser-control-broker.fixture.js";
import { createWorkflowActorRuntimeFactory } from "./workflow-actor-runtime.js";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import { mintActorSessionId } from "./workflow-driver-helpers.js";

for (const stage of ["model-binding", "session-persistence", "rehydration", "task-link"] as const) {
  test(`actor ${stage} failure is owned and closes its scope before same-ID retry`, async () => {
    const { port } = browserFixture();
    const actor = { siteId: "actor#2", ordinal: 1 };
    const runId = `fixture-${stage}`;
    const sessionId = mintActorSessionId(runId, actor);
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId, status: "running", caps: { maxConcurrency: 1 }, spentTokens: 0 });
    journal.putActor({ runId, ...actor, ...(stage === "rehydration" ? { sessionId } : {}) });
    let closed = 0;
    const factory = createWorkflowActorRuntimeFactory({
      runId,
      parentSessionId: "root",
      recordedActorModels: { overrides: [] },
      deps: {
        journal,
        createActorRuntime: ({ sessionId: id }) => {
          const scope = port.createChildScope!({ parentSessionId: "root", sessionId: id });
          return {
            getSessionModelSelection: () =>
              stage === "model-binding" ? undefined : { providerId: "fixture", modelId: "fixture" },
            ensureSessionPersistedForExternalActivity: async () => {
              if (stage === "session-persistence") throw new Error("fixture persistence failure");
            },
            resumeFromStore: async () => {
              throw new Error("fixture rehydration failure");
            },
            closeBrowserSession: async () => {
              closed++;
              await scope.closeSession!({ sessionId: id });
            },
          } as unknown as AgentRuntime;
        },
        taskLinkStore: {
          createSessionTaskLink: async () => {
            throw new Error("fixture link failure");
          },
        },
      },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const work: Promise<unknown>[] = [];
        const driver = createAgentRuntimeWorkflowDriver({
          runId,
          journal,
          emit() {},
          runtimeFactory: factory,
          registerResidencyBlockingWork: (promise: Promise<unknown>) => work.push(promise),
        } as unknown as AgentRuntimeWorkflowDriverDeps)(
          new Proxy({}, { get: () => () => {} }) as WorkflowReportSink,
        );
        await assert.rejects(driver.createActorSession(actor, {}), (error: unknown) => {
          assert.doesNotMatch(String(error), /already active/);
          return true;
        });
        driver.dispose!();
        await Promise.all(work);
        assert.equal(closed, attempt + 1);
        await assert.rejects(port.list({ sessionId }), /not active/);
      }
    } finally {
      await port.closeSession!({ sessionId });
    }
  });
}
