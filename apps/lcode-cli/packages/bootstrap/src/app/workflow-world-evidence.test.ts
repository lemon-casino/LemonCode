import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeFileSystemAdapter, createSqliteSessionStore } from "@lcode/adapters";
import { readGoalEvidenceSummary } from "@lcode/core";
import {
  goalAcceptanceSchema,
  type SessionId,
  type ProjectId,
  type ExecutionPort,
} from "@lcode/contracts";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";

test("world.run live facts bind integrated bytes; engine replay adds no execution or evidence, and active actors cannot pass final acceptance", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lcode-workflow-evidence-"));
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionId = "workflow-evidence" as SessionId;
  const journal = new InMemoryJournalStore();
  let executions = 0;
  let mode: "complete" | "missing-code" | "truncated" = "complete";
  let actorDuringCommand: "running" | "completed" | undefined;
  try {
    await writeFile(join(cwd, "source.ts"), "implementation");
    await store.createSession({
      id: sessionId,
      projectID: "project" as ProjectId,
      directory: cwd,
      slug: "goal",
      title: "goal",
      version: "1",
    });
    const goal = await store.setTarget({
      sessionID: sessionId,
      objective: "integrated check",
      acceptance: goalAcceptanceSchema.parse({
        policy: "strict",
        requirements: [
          {
            id: "integration",
            description: "integrated test",
            source: "world.run",
            command: "node",
            args: ["check.mjs"],
            inputPaths: ["source.ts"],
          },
        ],
      }),
    });
    const owner = {
      sessionId,
      workspacePath: cwd,
      workspaceKey: cwd,
      fileSystem: createNodeFileSystemAdapter(),
      store,
    };
    const executionPort = {
      run: async (request: { cwd: string }) => {
        assert.equal(request.cwd, cwd);
        executions++;
        if (actorDuringCommand)
          journal.putNode({
            runId: "integrated-run",
            siteId: `late-writer-${actorDuringCommand}`,
            ordinal: 1,
            kind: "ask",
            inputHash: "late-writer",
            status: actorDuringCommand,
          });
        return {
          status: "completed",
          ...(mode !== "missing-code" ? { exitCode: 0 } : {}),
          stdout: { text: "checked", bytes: 7, truncated: mode === "truncated" },
          stderr: { text: "", bytes: 0, truncated: false },
        };
      },
    } as unknown as ExecutionPort;
    const driver = createAgentRuntimeWorkflowDriver({
      journal,
      runId: "integrated-run",
      emit: () => {},
      cwd,
      executionPort,
      fileSystemPort: owner.fileSystem,
      goalEvidenceOwner: owner,
      declaredRunCommands: new Set(["node"]),
      escalationRegistry: {} as never,
      runtimeFactory: () => {
        throw new Error("No actor requested");
      },
    })({} as WorkflowReportSink);
    const config = {
      runId: "integrated-run",
      driver,
      caps: { maxConcurrency: 1 },
      askSpecs: new Map(),
      validate: () => [],
    };
    const engine = new WorkflowEngine(config);
    const args = ["node", ["check.mjs"]];
    await engine.worldRead("gate", "run", args);
    assert.equal((await readGoalEvidenceSummary(owner, goal))?.outcome, "pass");
    assert.equal(executions, 1);
    const restored = new WorkflowEngine(config);
    await restored.worldRead("gate", "run", args);
    assert.equal(executions, 1, "replay never called the execution port");
    assert.equal(
      (await store.sessionEntries({ sessionID: sessionId, type: "goal/evidence/v1" })).length,
      1,
    );
    await writeFile(join(cwd, "source.ts"), "integrated changes after branch check");
    assert.equal((await readGoalEvidenceSummary(owner, goal))?.requirements[0]?.status, "stale");
    await restored.worldRead("final-check", "run", args);
    assert.equal((await readGoalEvidenceSummary(owner, goal))?.outcome, "pass");
    journal.putNode({
      runId: "integrated-run",
      siteId: "writer",
      ordinal: 1,
      kind: "ask",
      inputHash: "writer",
      status: "running",
    });
    await restored.worldRead("premature", "run", args);
    assert.equal((await readGoalEvidenceSummary(owner, goal))?.requirements[0]?.status, "unknown");
    journal.putNode({
      runId: "integrated-run",
      siteId: "writer",
      ordinal: 1,
      kind: "ask",
      inputHash: "writer",
      status: "completed",
    });
    mode = "missing-code";
    const legacyValue = (await restored.worldRead("missing-code", "run", args)) as {
      exitCode: number;
    };
    assert.equal(legacyValue.exitCode, 0, "legacy facade fallback is preserved");
    assert.equal(
      (await readGoalEvidenceSummary(owner, goal))?.requirements[0]?.status,
      "unknown",
      "strict uses actual adapter code, not fallback zero",
    );
    mode = "truncated";
    await assert.rejects(restored.worldRead("truncated", "run", args), /cap|stdout|over/i);
    assert.equal((await readGoalEvidenceSummary(owner, goal))?.outcome, "incomplete");
    mode = "complete";
    for (const status of ["running", "completed"] as const) {
      actorDuringCommand = status;
      await restored.worldRead(`actor-during-${status}`, "run", args);
      assert.equal(
        (await readGoalEvidenceSummary(owner, goal))?.requirements[0]?.status,
        "unknown",
        "an actor launched during the command requires a new final check",
      );
      journal.putNode({
        runId: "integrated-run",
        siteId: `late-writer-${status}`,
        ordinal: 1,
        kind: "ask",
        inputHash: "late-writer",
        status: "completed",
      });
      actorDuringCommand = undefined;
      await restored.worldRead(`final-after-${status}`, "run", args);
      assert.equal((await readGoalEvidenceSummary(owner, goal))?.outcome, "pass");
    }
    const beforeRejectedStart = executions;
    store.beginGoalEvidenceExecution = async () => {
      throw new Error("Injected durable world start failure");
    };
    await assert.rejects(restored.worldRead("failed-start", "run", args), /start could not be persisted/);
    assert.equal(executions, beforeRejectedStart, "world driver must not swallow strict start failure");
    await store.setTarget({ sessionID: sessionId, objective: "legacy world command" });
    await restored.worldRead("legacy-after-start-failure", "run", args);
    assert.equal(executions, beforeRejectedStart + 1, "legacy world calls do not require strict admission");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
