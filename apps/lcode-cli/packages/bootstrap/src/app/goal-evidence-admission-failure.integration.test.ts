import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore, createNodeFileSystemAdapter } from "@lcode/adapters";
import { AgentRuntime, readGoalEvidenceSummary } from "@lcode/core";
import { createRootTraceContext, createInMemorySessionEventStore, goalAcceptanceSchema, type ExecutionPort, type Model, type SessionId } from "@lcode/contracts";

test("real Runtime blocks matched Bash before execution when durable admission or policy discovery fails", async () => {
  for (const scenario of ["start-write", "policy-read", "missing-capability", "unknown-input", "unknown-binding", "duplicate"] as const) {
    const cwd = await mkdtemp(join(tmpdir(), "lcode-goal-admission-"));
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = `goal-admission-${scenario}` as SessionId;
    let executions = 0;
    const fs = createNodeFileSystemAdapter();
    const model = { providerId: "fixture", modelId: "fixture", optionSpecs: {}, properties: { inputFormat: { supportsText: true } }, options: {}, bind: () => model } as unknown as Model;
    const runtime = new AgentRuntime(sessionId,
      { workingDirectory: cwd, workspacePath: cwd, mode: "yolo", modelSelection: { providerId: "fixture", modelId: "fixture" }, memory: { enabled: false }, subagents: { enabled: false } },
      { sessionStore: store, eventStore: createInMemorySessionEventStore(), modelFactory: () => model, fileSystemPort: fs,
        executionPort: { run: async () => { executions++; return { status: "completed", exitCode: 0, timedOut: false, cancelled: false, durationMs: 1, startedAt: new Date(), completedAt: new Date(), stdout: { text: "checked", bytes: 7, truncated: false }, stderr: { text: "", bytes: 0, truncated: false } }; } } as unknown as ExecutionPort });
    try {
      await writeFile(join(cwd, "source.ts"), "implemented");
      await runtime.ensureSessionPersistedForExternalActivity("work");
      const goal = await store.setTarget({ sessionID: sessionId, objective: "Verify", acceptance: goalAcceptanceSchema.parse({ policy: "strict", requirements: [{ id: "check", description: "check", source: "Bash", command: "node check.mjs", inputPaths: ["source.ts"] }] }) });
      await runtime.recordTargetChanged({ action: "set", source: "command", target: goal, traceContext: createRootTraceContext() });
      const execute = (id: string) => runtime.getToolExecutor().execute({ id, name: "Bash", input: { command: "node check.mjs" } } as never);
      assert.equal((await execute("original")).success, true);
      const begin = store.beginGoalEvidenceExecution.bind(store);
      const read = store.readTarget.bind(store);
      const session = store.getSession.bind(store);
      if (scenario === "start-write") store.beginGoalEvidenceExecution = async () => { throw new Error("Injected start write failure"); };
      if (scenario === "policy-read") store.readTarget = async () => { throw new Error("Injected policy read failure"); };
      if (scenario === "missing-capability") (store as unknown as { beginGoalEvidenceExecution?: unknown }).beginGoalEvidenceExecution = undefined;
      if (scenario === "unknown-input") await rm(join(cwd, "source.ts"));
      if (scenario === "unknown-binding") store.getSession = async () => null;
      assert.equal((await execute(scenario === "duplicate" ? "original" : "blocked")).success, false, scenario);
      assert.equal(executions, 1, `${scenario} must not invoke the physical ExecutionPort`);
      store.beginGoalEvidenceExecution = begin;
      store.readTarget = read;
      store.getSession = session;
      await writeFile(join(cwd, "source.ts"), "implemented");
      if (scenario === "unknown-input")
        assert.equal((await readGoalEvidenceSummary({ sessionId, workspacePath: cwd, workspaceKey: cwd, store, fileSystem: fs }, goal))?.outcome, "incomplete", "restored bytes cannot revive the pass before the rejected unknown-input attempt");
      await store.setTarget({ sessionID: sessionId, objective: "Legacy execution" });
      store.beginGoalEvidenceExecution = async () => { throw new Error("Legacy must not call strict admission"); };
      assert.equal((await execute("legacy")).success, true);
      assert.equal(executions, 2, "legacy execution remains compatible");
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
