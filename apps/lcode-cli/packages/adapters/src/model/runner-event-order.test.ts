import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  type ModelNetworkStatusEvent,
  type ModelStreamEvent,
} from "@lcode/contracts";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

const resolved = {
  model: {},
  modelId: createModelId("fixture-model"),
  providerId: createModelProviderId("fixture-provider"),
  providerKind: "openai-compatible",
  properties: {
    contextWindow: 128_000,
    inputFormat: { image: false, text: true },
    outputFormat: { text: true },
    requiresMfjsToolSchema: false,
    supportsJsonSchemaOutput: false,
    supportsMidConversationSystem: true,
    supportsNativeWebSearch: false,
    supportsToolCall: true,
  },
} as unknown as ResolvedAiSdkModel;
const retry = { backoffFactor: 1, baseDelayMs: 0, jitter: false, maxAttempts: 2, maxDelayMs: 0 };
const env = { LCODE_RUNTIME_ENV: "test" };
const usage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 };

function common(runtime: AiSdkModelRuntime, request: AiSdkModelTextRequest) {
  return {
    env,
    modelIoFullRetentionEnabled: false,
    request,
    resolveModel: () => resolved,
    resolved,
    retry,
    runtime,
    streamIdleTimeoutMs: 1_000,
  };
}

function streamRuntime(chunks: () => AsyncIterable<unknown>): AiSdkModelRuntime {
  return {
    async generateText() {
      throw new Error("unexpected generateText");
    },
    streamText() {
      return { fullStream: chunks() } as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };
}

function observedRequest(
  order: string[],
  statuses: ModelNetworkStatusEvent[],
): AiSdkModelTextRequest {
  return {
    messages: [{ content: "continue", role: "user" }],
    modelRequestAdmission: {
      async acquire() {
        order.push("admit");
        return {
          publish() {},
          release() {
            order.push("release");
          },
        };
      },
    },
    statusSink: {
      publish(event) {
        statuses.push(event);
        order.push(event.type);
      },
    },
  };
}

test("stream discards retry-safe tool prelude and publishes only the successful call before usage", async () => {
  const order: string[] = [];
  const statuses: ModelNetworkStatusEvent[] = [];
  let attempts = 0;
  const runtime = streamRuntime(async function* () {
    attempts += 1;
    yield { type: "start" };
    yield { id: "tool-a", toolName: "Read", type: "tool-input-start" };
    yield { delta: '{"path":', id: "tool-a", type: "tool-input-delta" };
    if (attempts === 1) {
      throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
    }
    yield { delta: '"file.ts"}', id: "tool-a", type: "tool-input-delta" };
    yield { id: "tool-a", type: "tool-input-end" };
    yield { input: { path: "file.ts" }, toolCallId: "tool-a", toolName: "Read", type: "tool-call" };
    yield { finishReason: "tool-calls", totalUsage: usage, type: "finish" };
  });
  const events: ModelStreamEvent[] = [];
  for await (const event of runStreamText(common(runtime, observedRequest(order, statuses)))) {
    events.push(event);
    order.push(event.type);
  }

  assert.equal(attempts, 2);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "tool_input_start",
      "tool_input_delta",
      "tool_input_delta",
      "tool_input_end",
      "tool_call",
      "finish",
    ],
  );
  assert.deepEqual(order, [
    "admit",
    "model_request_started",
    "model_request_failed",
    "model_retry_scheduled",
    "release",
    "admit",
    "model_request_started",
    "start",
    "tool_input_start",
    "tool_input_delta",
    "tool_input_delta",
    "tool_input_end",
    "tool_call",
    "finish",
    "model_request_completed",
    "release",
  ]);
  const finish = events.at(-1);
  assert.equal(finish?.type, "finish");
  if (finish?.type === "finish") assert.equal(finish.usage?.totalTokens, 6);
  const completed = statuses.at(-1);
  assert.equal(completed?.type, "model_request_completed");
  if (completed?.type === "model_request_completed") assert.equal(completed.usage?.totalTokens, 6);
});

test("opaque reasoning metadata remains ordered and visible partial output prevents replay", async () => {
  let calls = 0;
  const metadata = { anthropic: { signature: "fixture-opaque-signature" } };
  const runtime = streamRuntime(async function* () {
    calls += 1;
    yield { type: "start" };
    yield { id: "r", providerMetadata: metadata, type: "reasoning-start" };
    yield { id: "r", providerMetadata: metadata, text: "", type: "reasoning-delta" };
    yield { id: "r", text: "partial", type: "reasoning-delta" };
    throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
  });
  const events: ModelStreamEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runStreamText(common(runtime, { messages: [] }))) events.push(event);
  });
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "reasoning_start", "reasoning_delta", "reasoning_delta"],
  );
  const opaque = events[2];
  assert.equal(opaque?.type, "reasoning_delta");
  if (opaque?.type === "reasoning_delta") {
    assert.equal(opaque.text, "");
    assert.equal(opaque.providerMetadata, metadata);
  }
});

test("compact consumer close aborts and schedules best-effort cleanup while releasing admission", async () => {
  const order: string[] = [];
  const statuses: ModelNetworkStatusEvent[] = [];
  let signal: AbortSignal | undefined;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("unexpected generateText");
    },
    streamText(options) {
      signal = options.abortSignal;
      return {
        fullStream: {
          async *[Symbol.asyncIterator]() {
            try {
              yield { id: "text", text: "partial", type: "text-delta" };
            } finally {
              order.push("iterator_closed");
            }
          },
        },
      } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
    },
  };
  const iterator = runStreamText(
    common(runtime, {
      ...observedRequest(order, statuses),
      preserveProviderStreamBoundaries: true,
    }),
  );
  assert.equal((await iterator.next()).value?.type, "text_delta");
  await iterator.return(undefined);
  assert.equal(signal?.aborted, true);
  // consumer 主动关闭沿用非阻塞清理；只有失败重试路径等待 iterator 清理后才再次调用 provider。
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [
    "admit",
    "model_request_started",
    "model_request_failed",
    "release",
    "iterator_closed",
  ]);
  const failure = statuses.at(-1);
  assert.equal(failure?.type, "model_request_failed");
  if (failure?.type === "model_request_failed") {
    assert.equal(failure.reason, "cancelled");
    assert.equal(failure.streamOutputCommitted, true);
  }
});

for (const transport of ["generate", "stream"] as const) {
  test(`${transport} keeps the request's initial retry budget when provider callbacks mutate it`, async () => {
    const order: string[] = [];
    const statuses: ModelNetworkStatusEvent[] = [];
    const request = observedRequest(order, statuses);
    const fail = (): never => {
      request.modelRetryBudget = "unbounded";
      throw Object.assign(new Error("fixture reset"), { code: "ECONNRESET" });
    };
    const runtime: AiSdkModelRuntime = {
      async generateText() {
        return fail();
      },
      streamText() {
        return {
          fullStream: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  return fail();
                },
              };
            },
          },
        } as unknown as ReturnType<AiSdkModelRuntime["streamText"]>;
      },
    };
    const input = { ...common(runtime, request), retry: { ...retry, maxAttempts: 1 } };
    await assert.rejects(async () => {
      if (transport === "generate") {
        await runGenerateText(input);
      } else {
        for await (const _event of runStreamText(input)) assert.fail("unexpected output");
      }
    });
    // 预算属于逻辑请求入口的快照，helper 不能因再次读取可变 request 而发布额外重试。
    assert.deepEqual(order, ["admit", "model_request_started", "model_request_failed", "release"]);
    const failure = statuses.at(-1);
    assert.equal(failure?.type, "model_request_failed");
    if (failure?.type === "model_request_failed") assert.equal(failure.retryable, false);
  });
}

test("generate publishes normalized total usage before releasing admission and returning", async () => {
  const order: string[] = [];
  const statuses: ModelNetworkStatusEvent[] = [];
  const runtime: AiSdkModelRuntime = {
    async generateText(options) {
      order.push("provider");
      assert.deepEqual(options.messages, [{ content: "continue", role: "user" }]);
      return {
        finishReason: "stop",
        text: "done",
        totalUsage: usage,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as Awaited<ReturnType<AiSdkModelRuntime["generateText"]>>;
    },
    streamText() {
      throw new Error("unexpected streamText");
    },
  };
  const result = await runGenerateText(common(runtime, observedRequest(order, statuses)));
  order.push("returned");
  assert.equal(result.usage.totalTokens, 6);
  assert.deepEqual(order, [
    "admit",
    "model_request_started",
    "provider",
    "model_request_completed",
    "release",
    "returned",
  ]);
  const completed = statuses.at(-1);
  assert.equal(completed?.type, "model_request_completed");
  if (completed?.type === "model_request_completed") assert.equal(completed.usage?.totalTokens, 6);
});
