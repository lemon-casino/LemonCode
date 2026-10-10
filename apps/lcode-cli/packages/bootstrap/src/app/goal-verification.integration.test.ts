import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSqliteSessionStore, createNodeFileSystemAdapter } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createRootTraceContext,
  createInMemorySessionEventStore,
  goalAcceptanceSchema,
  type ExecutionPort,
  type Model,
  type SessionId,
} from "@lcode/contracts";

for (const scenario of ["strict-pass", "strict-invalid", "legacy-invalid"] as const)
  test(`actual Runtime Bash, accounting and completion policy: ${scenario}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lcode-strict-goal-runtime-"));
    const store = createSqliteSessionStore({ dbPath: ":memory:" });
    const sessionId = "real-goal" as SessionId;
    let requests = 0;
    try {
      await writeFile(join(cwd, "source.ts"), "implemented");
      await writeFile(
        join(cwd, "goal-check.mjs"),
        "import {readFile} from 'node:fs/promises'; if (await readFile('source.ts','utf8') !== 'implemented') process.exitCode=1; process.stdout.write('checked');",
      );
      const model = {
        providerId: "fixture",
        modelId: "fixture",
        optionSpecs: { maxOutputTokens: { max: 512 } },
        properties: { inputFormat: { supportsText: true }, supportsMidConversationSystem: true },
        options: {},
        bind: () => model,
        generateText: async () => {
          requests++;
          const target = (await store.readTarget({ sessionID: sessionId }))!;
          // 用量和计时更新不改变单调状态版本，不能卡住合法的严格完成。
          await store.accountTargetUsage({
            sessionID: sessionId,
            targetID: target.targetID,
            tokensUsedDelta: 1,
          });
          return {
            text:
              scenario === "strict-pass"
                ? '{"passed":true,"reason":"actual check covers the task","nextAction":""}'
                : "invalid JSON",
            finishReason: "stop",
          };
        },
      } as unknown as Model;
      const executionPort = {
        run: async (request: { cwd: string }) => {
          assert.equal(request.cwd, cwd);
          const result = await promisify(execFile)(process.execPath, ["goal-check.mjs"], { cwd });
          return {
            status: "completed",
            exitCode: 0,
            timedOut: false,
            cancelled: false,
            durationMs: 1,
            startedAt: new Date(),
            completedAt: new Date(),
            stdout: {
              text: result.stdout,
              bytes: Buffer.byteLength(result.stdout),
              truncated: false,
            },
            stderr: {
              text: result.stderr,
              bytes: Buffer.byteLength(result.stderr),
              truncated: false,
            },
          };
        },
      } as unknown as ExecutionPort;
      const runtime = new AgentRuntime(
        sessionId,
        {
          workingDirectory: cwd,
          workspacePath: cwd,
          mode: "yolo",
          modelSelection: { providerId: "fixture", modelId: "fixture" },
          memory: { enabled: false },
          subagents: { enabled: false },
          targetCompletionVerification: { enabled: scenario !== "strict-pass" },
        },
        {
          sessionStore: store,
          eventStore: createInMemorySessionEventStore(),
          modelFactory: () => model,
          fileSystemPort: createNodeFileSystemAdapter(),
          executionPort,
        },
      );
      await runtime.ensureSessionPersistedForExternalActivity("work");
      const acceptance = goalAcceptanceSchema.parse({
        policy: "strict",
        requirements: [
          {
            id: "check",
            description: "source behavior checked",
            source: "Bash",
            command: "node goal-check.mjs",
            inputPaths: ["source.ts", "goal-check.mjs"],
          },
        ],
      });
      const goal = await store.setTarget({
        sessionID: sessionId,
        objective: "Implement and verify source",
        ...(scenario !== "legacy-invalid" ? { acceptance } : {}),
      });
      const traceContext = createRootTraceContext();
      await runtime.recordTargetChanged({
        action: "set",
        source: "command",
        target: goal,
        traceContext,
      });
      const executed = await runtime.getToolExecutor().execute({
        id: "live-check",
        name: "Bash",
        input: { command: "node goal-check.mjs" },
      } as never);
      assert.equal(executed.success, true, JSON.stringify(executed.error));
      await runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true });
      assert.equal(requests, 1);
      assert.equal(
        (await store.readTarget({ sessionID: sessionId }))?.status,
        scenario === "strict-invalid" ? "active" : "complete",
      );
      const projection = await runtime.getProjection();
      const verification = projection.targetCompletionVerificationTimeline.at(-1)?.verification;
      assert.equal(verification?.passed, scenario !== "strict-invalid");
      assert.equal(
        verification?.evidenceSummary?.outcome,
        scenario === "legacy-invalid"
          ? undefined
          : scenario === "strict-invalid"
            ? "incomplete"
            : "pass",
      );
      assert.equal(
        (await store.sessionEntries({ sessionID: sessionId, type: "goal/evidence/v1" })).length,
        scenario === "legacy-invalid" ? 0 : 1,
      );
    } finally {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    }
  });
