import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type {
  BashOutput,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
  FileSystemPort,
  ReadOutput,
  SessionEvent,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { createBashToolEntry } from "./bash.js";
import { readToolEntry } from "./read.js";

function executionContext(patch: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "handler-call",
    sessionId: "handler-session",
    traceId: "handler-trace",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    runtimeScope: "main",
    ...patch,
  } as ToolExecutionContext;
}

function executionResult(): ExecutionResult {
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text: "test-output", bytes: 11, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 3,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(1000),
    completedAt: new Date(1003),
  };
}

test("Bash request retains timeout policy, signal, progress and cwd ordering", async () => {
  const requests: ExecutionRequest[] = [];
  const events: SessionEvent[] = [];
  const controller = new AbortController();
  const cwd = join(process.cwd(), "child");
  const order: string[] = [];
  const executionPort = {
    run: async (request: ExecutionRequest, options: ExecutionRunOptions) => {
      requests.push(request);
      assert.equal(options.signal, controller.signal);
      await options.onEvent?.({
        type: "progress",
        elapsedMs: 2,
        stdoutBytes: 11,
        stderrBytes: 0,
        timestamp: new Date(),
      });
      return { ...executionResult(), resolvedCwd: cwd };
    },
  } as ExecutionPort;
  const entry = createBashToolEntry({
    bashTimeoutPolicy: { defaultTimeoutMs: 1234, maxTimeoutMs: 5678 },
  });
  const output = (await entry.handler(
    { command: "mock-command", timeout: 0 },
    executionContext({
      executionPort,
      abortSignal: controller.signal,
      emitEvent: async (event) => {
        events.push(event);
      },
      setWorkingDirectory: async (path) => {
        assert.equal(path, cwd);
        order.push("cwd");
      },
    }),
  )) as BashOutput;
  order.push("result");
  assert.equal(requests[0]?.timeoutMs, 1234);
  assert.equal(requests[0]?.captureCwdAfterSuccess, true);
  assert.equal(requests[0]?.sandbox?.enabled, true);
  assert.equal(output.stdout, "test-output");
  assert.equal(events.length, 1);
  assert.deepEqual(order, ["cwd", "result"]);
});

test("Bash explicit background uses its lifecycle port and never retries a rejected request", async () => {
  let foregroundCalls = 0;
  let backgroundCalls = 0;
  const context = executionContext({
    executionPort: {
      run: async () => {
        foregroundCalls++;
        return executionResult();
      },
      runBashWithBackgroundLifecycle: async (_request: unknown, policy: { mode: string }) => {
        backgroundCalls++;
        assert.equal(policy.mode, "explicit");
        return { kind: "backgrounded", task: { taskId: "mock-task", outputPath: "mock-output" } };
      },
    } as unknown as ExecutionPort,
  });
  const entry = createBashToolEntry();
  const output = (await entry.handler(
    { command: "mock-command", run_in_background: true },
    context,
  )) as BashOutput;
  assert.equal(output.backgroundTaskId, "mock-task");
  assert.equal(backgroundCalls, 1);
  assert.equal(foregroundCalls, 0);
  await assert.rejects(
    entry.handler(
      { command: "mock-command", run_in_background: true },
      {
        ...context,
        offPeakTurn: true,
      },
    ),
    /Idle-time tasks do not support background commands/,
  );
  assert.equal(backgroundCalls, 1);
  assert.equal(foregroundCalls, 0);
});

test("Read preserves context-owned fallback cache and revision invalidation", async () => {
  let reads = 0;
  let mtimeMs = 1000;
  const filePath = join(process.cwd(), "fixture.txt");
  const recorded: unknown[] = [];
  const fileSystemPort = {
    stat: async () => ({
      path: filePath,
      kind: "file",
      sizeBytes: 11,
      revision: { id: `revision-${mtimeMs}`, mtimeMs },
    }),
    readTextFileRange: async () => {
      reads++;
      return {
        path: filePath,
        content: "first\nlast",
        encoding: "utf-8",
        bytesRead: 11,
        sizeBytes: 11,
        truncated: false,
        startLine: 1,
        lineCount: 2,
        totalLines: 2,
        revision: { id: `revision-${mtimeMs}`, mtimeMs },
      };
    },
  } as unknown as FileSystemPort;
  const context = executionContext({
    fileSystemPort,
    recordReadFileStateMetadata: (metadata) => {
      recorded.push(metadata);
    },
  });
  const first = (await readToolEntry.handler({ file_path: filePath }, context)) as ReadOutput;
  assert.equal(readToolEntry.formatModelContent?.(first), "1\tfirst\n2\tlast");
  const second = (await readToolEntry.handler({ file_path: filePath }, context)) as ReadOutput;
  assert.equal(second.type, "file_unchanged");
  assert.equal(reads, 1);
  mtimeMs++;
  assert.equal(
    ((await readToolEntry.handler({ file_path: filePath }, context)) as ReadOutput).type,
    "text",
  );
  assert.equal(reads, 2);
  await readToolEntry.handler({ file_path: filePath }, { ...context });
  assert.equal(reads, 3);
  assert.equal(recorded.length, 4);
});

test("Read invalid inputs preserve preflight failure and media-only output", async () => {
  let stats = 0;
  const context = executionContext({
    fileSystemPort: {
      stat: async () => {
        stats++;
      },
    } as unknown as FileSystemPort,
  });
  await assert.rejects(
    readToolEntry.handler({ file_path: "blocked.exe" }, context),
    /tool_use_error/,
  );
  assert.equal(stats, 0);
  assert.equal(
    readToolEntry.validateInput?.({ file_path: "file.pdf", pages: "0" }, {}).result,
    false,
  );
  const content = readToolEntry.formatModelContent?.({
    type: "image",
    mimeType: "image/png",
    base64: "aGVsbG8=",
    originalSize: 5,
  });
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "image");
});
