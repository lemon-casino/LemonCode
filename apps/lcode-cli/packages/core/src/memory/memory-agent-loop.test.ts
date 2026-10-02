import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  Model,
  ModelInputMessage,
  ModelRequest,
  ModelToolCall,
  ModelToolContract,
} from "@lcode/contracts";
import type { ToolExecutionResult } from "../tool/types.js";
import { runMemoryAgentLoop } from "./memory-agent-loop.js";

const ROOT = resolve("memory-loop-fixture");
const TOOLS: ModelToolContract[] = ["Read", "Write", "Edit", "Bash", "Agent"].map((name) => ({
  name,
  inputSchema: { type: "object" },
}));

function harness(toolCalls: ModelToolCall[], supportsImage = false) {
  const requests: ModelRequest[] = [];
  const model = {
    properties: { inputFormat: { supportsImage, supportsPdf: false, supportsVideo: false } },
    optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 1024 } },
    async generateText(request: ModelRequest) {
      requests.push(request);
      return { text: "done", toolCalls: requests.length === 1 ? toolCalls : [] };
    },
  } as unknown as Model;
  return {
    requests,
    input: {
      maxTurns: 2,
      messages: [{ role: "user", content: "remember this preference" }] as ModelInputMessage[],
      model,
      rootDir: ROOT,
      tools: TOOLS,
      workingDirectory: ROOT,
      workspaceRoot: ROOT,
    },
  };
}

function toolResult(
  call: ModelToolCall,
  patch: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    output: "done",
    startedAt: new Date(0),
    completedAt: new Date(0),
    durationMs: 0,
    ...patch,
  };
}

test("tools in the same response execute in declaration order, including same-file writes", async () => {
  const calls = ["Read", "Write", "Edit"].map((name, index) => ({
    id: String(index),
    name,
    input: { file_path: join(ROOT, "preference.md") },
  }));
  const h = harness(calls);
  const events: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await runMemoryAgentLoop({
    ...h.input,
    executeTool: async (call) => {
      peak = Math.max(peak, ++active);
      events.push(`start:${call.name}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push(`end:${call.name}`);
      active -= 1;
      return toolResult(call);
    },
  });
  assert.equal(peak, 1);
  assert.deepEqual(events, [
    "start:Read",
    "end:Read",
    "start:Write",
    "end:Write",
    "start:Edit",
    "end:Edit",
  ]);
  assert.equal(result.failedToolCalls, 0);
  assert.equal(result.turns, 2);
});

test("loop counts failed results and provider-visible errors even after a successful final response", async () => {
  const calls = ["Write", "Read", "Write"].map((name, index) => ({
    id: String(index),
    name,
    input: { file_path: join(ROOT, "preference.md") },
  }));
  const h = harness(calls);
  const result = await runMemoryAgentLoop({
    ...h.input,
    executeTool: async (call) =>
      toolResult(
        call,
        call.id === "0"
          ? { success: false, error: { type: "stale_write", message: "changed" } }
          : call.id === "1"
            ? { output: { isError: true } }
            : {},
      ),
  });
  assert.equal(result.failedToolCalls, 2);
  assert.deepEqual(
    result.messages.filter((message) => message.role === "tool").map((message) => message.isError),
    [true, true, false],
  );
});

test("rm is denied even for contained Markdown; the read-only catalog is preserved", async () => {
  const file = join(ROOT, "preference.md").replaceAll("\\", "/");
  const calls: ModelToolCall[] = [
    { id: "rm", name: "Bash", input: { command: `rm -- '${file}'` } },
    { id: "rm-force", name: "Bash", input: { command: `rm -f '${file}'` } },
    { id: "outside", name: "Write", input: { file_path: resolve(ROOT, "..", "outside.md") } },
    { id: "unknown", name: "NotRegistered", input: {} },
    { id: "agent", name: "Agent", input: {} },
    { id: "ls", name: "Bash", input: { command: "ls" } },
    { id: "read", name: "Read", input: { file_path: file } },
  ];
  const h = harness(calls);
  const executed: string[] = [];
  const result = await runMemoryAgentLoop({
    ...h.input,
    executeTool: async (call) => {
      executed.push(call.id);
      return toolResult(call);
    },
  });
  assert.deepEqual(executed, ["ls", "read"]);
  assert.equal(result.failedToolCalls, 5);
  assert.equal(h.requests[0]?.tools, TOOLS);
  assert.equal(result.messages.find((message) => message.toolCallId === "rm")?.isError, true);
  assert.match(
    String(result.messages.find((message) => message.toolCallId === "rm")?.content),
    /external editor/iu,
  );
});

test("abort between tools stops the remaining calls and the next model request", async () => {
  const calls = ["first", "second"].map((id) => ({
    id,
    name: "Write",
    input: { file_path: join(ROOT, "preference.md") },
  }));
  const h = harness(calls);
  const controller = new AbortController();
  const executed: string[] = [];
  await assert.rejects(
    runMemoryAgentLoop({
      ...h.input,
      maxTurns: 1,
      abortSignal: controller.signal,
      executeTool: async (call, options) => {
        assert.equal(options.abortSignal, controller.signal);
        executed.push(call.id);
        controller.abort();
        return toolResult(call);
      },
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(executed, ["first"]);
  assert.equal(h.requests.length, 1);
});

test("already-aborted work never requests a model or executes a tool", async () => {
  const h = harness([]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runMemoryAgentLoop({
      ...h.input,
      abortSignal: controller.signal,
      executeTool: async () => {
        throw new Error("must not execute");
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(h.requests.length, 0);
});

for (const supportsImage of [false, true]) {
  test(`Read media is projected on every request (supportsImage=${supportsImage}) without mutating history`, async () => {
    const h = harness(
      [{ id: "read-image", name: "Read", input: { file_path: join(ROOT, "fixture.png") } }],
      supportsImage,
    );
    const image = {
      type: "image" as const,
      dataUrl: "data:image/png;base64,Zml4dHVyZQ==",
      mimeType: "image/png",
    };
    h.input.messages[0] = { role: "user", content: [image] };
    const result = await runMemoryAgentLoop({
      ...h.input,
      executeTool: async (call) => toolResult(call, { modelContent: [image] }),
    });
    const projectedUser = h.requests[0]?.messages[0]?.content;
    const projectedTool = h.requests[1]?.messages.find(
      (message) => message.role === "tool",
    )?.content;
    assert.ok(Array.isArray(projectedUser));
    assert.ok(Array.isArray(projectedTool));
    assert.equal(projectedUser[0]?.type, supportsImage ? "image" : "text");
    assert.equal(projectedTool[0]?.type, supportsImage ? "image" : "text");
    assert.deepEqual(h.input.messages[0]?.content, [image]);
    assert.deepEqual(result.messages.find((message) => message.role === "tool")?.content, [image]);
    assert.equal(result.failedToolCalls, 0);
  });
}
