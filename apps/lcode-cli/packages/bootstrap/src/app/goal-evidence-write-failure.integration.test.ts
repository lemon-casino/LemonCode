import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSqliteSessionStore, createNodeFileSystemAdapter } from "@lcode/adapters";
import { AgentRuntime, readGoalEvidenceSummary } from "@lcode/core";
import { createRootTraceContext, createInMemorySessionEventStore, goalAcceptanceSchema, type ExecutionPort, type Model, type SessionId } from "@lcode/contracts";

test("a transient terminal receipt write failure cannot reuse an older pass in live or reopened SQLite Runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lcode-goal-write-failure-"));
  const dbPath = join(cwd, "session.db");
  const store = createSqliteSessionStore({ dbPath });
  const sessionId = "goal-write-failure" as SessionId;
  let reopened: ReturnType<typeof createSqliteSessionStore> | undefined;
  let failRun = false;
  let failWrite = false;
  let writeFailures = 0;
  let semanticCalls = 0;
  const exitCodes: number[] = [];
  const save = store.saveSessionEntry.bind(store);
  store.saveSessionEntry = async (entry) => {
    if (entry.type === "goal/evidence/v1" && failWrite) {
      failWrite = false;
      writeFailures++;
      throw new Error("Injected transient terminal receipt write failure");
    }
    return save(entry);
  };
  try {
    await writeFile(join(cwd, "source.ts"), "implemented");
    await writeFile(join(cwd, "check.mjs"), "process.stdout.write('checked'); if (process.env.FAIL_CHECK === '1') process.exitCode=1;");
    const model = { providerId: "fixture", modelId: "fixture", optionSpecs: { maxOutputTokens: { max: 512 } },
      properties: { inputFormat: { supportsText: true }, supportsMidConversationSystem: true }, options: {}, bind: () => model,
      generateText: async () => { semanticCalls++; return { text: '{"passed":true,"reason":"Fixture semantic approval","nextAction":""}', finishReason: "stop" }; },
    } as unknown as Model;
    const executionPort = { run: async (request: { cwd: string }) => {
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      try {
        const output = await promisify(execFile)(process.execPath, ["check.mjs"], { cwd: request.cwd, env: { ...process.env, FAIL_CHECK: failRun ? "1" : "0" }, encoding: "utf8" });
        stdout = output.stdout; stderr = output.stderr;
      } catch (error) {
        const failure = error as { code: number; stdout?: string; stderr?: string };
        exitCode = Number(failure.code); stdout = failure.stdout ?? ""; stderr = failure.stderr ?? "";
      }
      exitCodes.push(exitCode);
      return { status: "completed", exitCode, timedOut: false, cancelled: false, durationMs: 1, startedAt: new Date(), completedAt: new Date(),
        stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false }, stderr: { text: stderr, bytes: Buffer.byteLength(stderr), truncated: false } };
    } } as unknown as ExecutionPort;
    const fs = createNodeFileSystemAdapter();
    const runtime = new AgentRuntime(sessionId, { workingDirectory: cwd, workspacePath: cwd, mode: "yolo", modelSelection: { providerId: "fixture", modelId: "fixture" }, memory: { enabled: false }, subagents: { enabled: false } },
      { sessionStore: store, eventStore: createInMemorySessionEventStore(), modelFactory: () => model, fileSystemPort: fs, executionPort });
    await runtime.ensureSessionPersistedForExternalActivity("work");
    const goal = await store.setTarget({ sessionID: sessionId, objective: "Implement and verify source", acceptance: goalAcceptanceSchema.parse({ policy: "strict", requirements: [{ id: "check", description: "real execution check", source: "Bash", command: "node check.mjs", inputPaths: ["source.ts", "check.mjs"] }] }) });
    await runtime.recordTargetChanged({ action: "set", source: "command", target: goal, traceContext: createRootTraceContext() });
    assert.equal((await runtime.getToolExecutor().execute({ id: "first-check", name: "Bash", input: { command: "node check.mjs" } } as never)).success, true);
    const originalReceipt = (await store.sessionEntries({ sessionID: sessionId, type: "goal/evidence/v1" }))[0];
    failRun = true; failWrite = true;
    assert.equal((await runtime.getToolExecutor().execute({ id: "failed-check", name: "Bash", input: { command: "node check.mjs" } } as never)).success, true);
    const owner = { sessionId, workspacePath: cwd, workspaceKey: cwd, fileSystem: fs, store };
    const live = await readGoalEvidenceSummary(owner, goal);
    await runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true });
    reopened = createSqliteSessionStore({ dbPath });
    const cold = await readGoalEvidenceSummary({ ...owner, store: reopened }, (await reopened.readTarget({ sessionID: sessionId }))!);
    assert.deepEqual(exitCodes, [0, 1]);
    assert.equal(writeFailures, 1);
    assert.deepEqual((await store.sessionEntries({ sessionID: sessionId, type: "goal/evidence/v1" }))[0], originalReceipt);
    assert.equal(live?.outcome, "incomplete");
    assert.equal(cold?.outcome, "incomplete");
    assert.equal(semanticCalls, 0);
    assert.equal((await store.readTarget({ sessionID: sessionId }))?.status, "active");
  } finally { reopened?.close(); store.close(); await rm(cwd, { recursive: true, force: true }); }
});
