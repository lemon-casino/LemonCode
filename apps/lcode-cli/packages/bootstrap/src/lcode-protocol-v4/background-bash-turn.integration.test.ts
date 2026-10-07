import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionAdapter } from "@lcode/adapters";
import { AgentRuntime } from "@lcode/core";
import {
  createSessionId,
  SessionEventType,
  type Model,
  type SessionEvent,
  type ModelTextRequest,
  type ModelTextResult,
} from "@lcode/contracts";

for (const exitCode of [0, 7, "cancel"] as const) {
  test(
    exitCode === "cancel"
      ? "cancel interrupts a real completion wait and settles its process tree"
      : `real background command exits ${exitCode}, resumes the same turn and cleans only the temporary service`,
    { timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "lcode-background-build-"));
      const adapter = new NodeExecutionAdapter({ outputRootDir: join(root, "output") });
      const release = join(root, "release");
      const buildScript = join(root, "build.cjs");
      const serviceScript = join(root, "service.cjs");
      await writeFile(
        buildScript,
        `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.argv[2])){console.log('BUILD_RESULT');process.exit(${exitCode === "cancel" ? 0 : exitCode});}},10);`,
      );
      await writeFile(serviceScript, "setInterval(()=>{},1000);");
      const nodePath = process.execPath.replaceAll("\\", "/");
      const command = (script: string) =>
        `"${nodePath}" "${script.replaceAll("\\", "/")}" "${release.replaceAll("\\", "/")}"`;
      const events: SessionEvent[] = [];
      const waiting = Promise.withResolvers<void>();
      let requests = 0;
      const model = {
        providerId: "fixture",
        modelId: "fixture",
        options: {},
        optionSpecs: { maxOutputTokens: { max: 4096 }, reasoningLevel: { values: [] } },
        properties: {
          contextWindow: 128000,
          inputFormat: { supportsText: true },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsMidConversationSystem: true,
        },
      } as unknown as Model;
      const next = (request: ModelTextRequest): ModelTextResult => {
        requests++;
        assert.ok(requests <= 3, "background result must not create duplicate model requests");
        if (requests === 1)
          return {
            text: "start build",
            finishReason: "tool-calls",
            usage: {},
            toolCalls: [
              {
                id: "fixture-build",
                name: "Bash",
                input: {
                  command: command(buildScript),
                  run_in_background: true,
                  description: "finite build",
                },
              },
              {
                id: "fixture-service",
                name: "Bash",
                input: {
                  command: command(serviceScript),
                  run_in_background: true,
                  background_kind: "service",
                  description: "temporary preview",
                },
              },
            ],
          };
        if (requests === 2)
          return {
            text: "Waiting for the build completion notification.",
            finishReason: "stop",
            usage: {},
          };
        assert.match(JSON.stringify(request.messages), /task-notification/);
        assert.match(
          JSON.stringify(request.messages),
          exitCode === 0 ? /completed \(exit code 0\)/ : /failed with exit code 7/,
        );
        return {
          text:
            exitCode === 0
              ? "validated build and finished remaining work"
              : "build failure handled",
          finishReason: "stop",
          usage: {},
        };
      };
      model.generateText = async (request) => next(request);
      model.streamText = async function* (request) {
        const result = next(request);
        for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
        if (result.text) yield { type: "text_delta", text: result.text };
        yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
      };
      const logger = {
        child: () => logger,
        debug: () => {},
        warn: () => {},
        error: () => {},
        info: (_message: string, context?: { event?: string }) => {
          if (context?.event === "runtime.background_bash.completion_wait") waiting.resolve();
        },
      };
      const runtime = new AgentRuntime(
        createSessionId(),
        {
          workingDirectory: root,
          mode: "yolo",
          modelSelection: { providerId: "fixture", modelId: "fixture" },
          compact: { enabled: false },
          memory: { enabled: false },
          mcp: { enabled: false },
          subagents: { enabled: false },
          titleGeneration: { enabled: false },
          modelStreaming: "on",
          streamingToolExecution: "off",
          toolAllowlist: ["Bash"],
          nativeSearchEnhancementsEnabled: false,
        },
        {
          modelFactory: () => model,
          executionPort: adapter,
          logger: logger as never,
          eventStore: {
            append: async (event: SessionEvent) => {
              const stored = { ...event, sequenceNumber: events.length + 1 };
              events.push(stored);
              return stored;
            },
            getEvents: async () => events,
          } as never,
        },
      );
      // 仅省略测试目录的上下文发现；模型、工具、进程、通知、轮次完成均走真实生产路径。
      (
        runtime as unknown as { ensureContextInitialized: () => Promise<void> }
      ).ensureContextInitialized = async () => {};
      const controller = new AbortController();
      let running: Promise<unknown> | undefined;
      try {
        running = runtime.executeTurn("build and validate", undefined, {
          abortSignal: AbortSignal.any([t.signal, controller.signal]),
        });
        await Promise.race([
          waiting.promise,
          running.then(() => assert.fail("turn completed before the build exited")),
        ]);
        const started = events.filter(
          (event) => event.type === SessionEventType.BackgroundTaskStarted,
        );
        assert.equal(started.length, 2);
        const taskIds = started.map((event) => (event.payload as { taskId: string }).taskId);
        assert.equal((await adapter.getBackgroundTask(taskIds[0]!))?.status, "running");
        assert.equal(
          events.some((event) => event.type === SessionEventType.TurnComplete),
          false,
        );
        if (exitCode === "cancel") {
          controller.abort(new Error("user cancelled"));
          await assert.rejects(running, /cancel|abort|interrupt/i);
          assert.equal(requests, 2);
          for (const id of taskIds)
            assert.equal((await adapter.getBackgroundTask(id))?.status, "cancelled");
          // 原协议使用 TurnComplete(cancelled) 收口用户取消，不能当成成功完成。
          const ended = events.filter((event) => event.type === SessionEventType.TurnComplete);
          assert.equal(ended.length, 1);
          const cancelled = ended[0];
          assert.ok(cancelled);
          assert.equal((cancelled.payload as { resultType: string }).resultType, "cancelled");
          return;
        }
        await writeFile(release, "release");
        await running;
        assert.equal(requests, 3);
        assert.equal(
          (await adapter.getBackgroundTask(taskIds[0]!))?.status,
          exitCode === 0 ? "completed" : "failed",
        );
        assert.equal((await adapter.getBackgroundTask(taskIds[1]!))?.status, "cancelled");
        const turns = events.filter(
          (event) =>
            event.type === SessionEventType.TurnStarted ||
            event.type === SessionEventType.TurnComplete,
        );
        assert.deepEqual(
          turns.map((event) => event.type),
          [SessionEventType.TurnStarted, SessionEventType.TurnComplete],
        );
        assert.equal(turns[0]?.turnId, turns[1]?.turnId);
        assert.equal(
          events.filter((event) => event.type === SessionEventType.BackgroundTaskResultConsumed)
            .length,
          1,
        );
      } finally {
        await adapter.close();
        await running?.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
