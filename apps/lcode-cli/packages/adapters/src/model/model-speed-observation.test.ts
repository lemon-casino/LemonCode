import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModel } from "ai";
import {
  observeModelSpeed,
  resolveModelSpeedResult,
  type ModelSpeedObservation,
} from "./model-speed-observation.js";

type SdkModel = Parameters<typeof wrapLanguageModel>[0]["model"];
const params = { prompt: [] };
const finishReason = { unified: "stop", raw: "stop" } as const;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function sdkModel(body: unknown, rawValues: unknown[] = []): SdkModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason, usage, warnings: [], response: { body } };
    },
    async doStream(options) {
      assert.equal(options.includeRawChunks, true);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const rawValue of rawValues) controller.enqueue({ type: "raw", rawValue });
            controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" });
            controller.close();
          },
        }),
      };
    },
  };
}

for (const [body, expected, tier] of [
  [{ service_tier: "priority" }, "confirmed", "priority"],
  [{ service_tier: "fast" }, "confirmed", "fast"],
  [{ service_tier: "performance" }, "confirmed", "performance"],
  [{ service_tier: "default" }, "downgraded", "default"],
  [{ usage: { speed: "standard" } }, "downgraded", "standard"],
  [{ usage: { speed: "fast" } }, "confirmed", "fast"],
  [{}, "unconfirmed", undefined],
  [{ service_tier: "private-content-must-not-be-logged" }, "unconfirmed", undefined],
] as const) {
  test(`non-streaming speed observation: ${JSON.stringify(body)}`, async () => {
    const observation: ModelSpeedObservation = { requested: "fast" };
    const result = await observeModelSpeed(sdkModel(body), observation).doGenerate(params);
    assert.equal(result.response?.body, body);
    assert.equal(observation.responseTier, tier);
    assert.equal(resolveModelSpeedResult(observation), expected);
  });
}

for (const includeRawChunks of [false, true]) {
  test(`SSE observes the final tier while preserving requested raw visibility (${includeRawChunks})`, async () => {
    const observation: ModelSpeedObservation = { requested: "fast" };
    const source = sdkModel(undefined, [
      { type: "response.created", response: { service_tier: "auto" } },
      { type: "response.completed", response: { service_tier: "priority" } },
    ]);
    const result = await observeModelSpeed(source, observation).doStream({
      ...params,
      includeRawChunks,
    });
    const chunks = await readStream(result.stream);
    assert.equal(chunks.length, includeRawChunks ? 3 : 1);
    assert.equal(chunks.at(-1)?.type, "text-delta");
    assert.equal(observation.responseTier, "priority");
    assert.equal(resolveModelSpeedResult(observation), "confirmed");
  });
}

test("Anthropic SSE reads message_start usage and keeps it across metadata-free deltas", async () => {
  const observation: ModelSpeedObservation = { requested: "fast" };
  const source = sdkModel(undefined, [
    { type: "message_start", message: { usage: { speed: "standard" } } },
    { type: "message_delta", usage: { output_tokens: 2 } },
  ]);
  await readStream((await observeModelSpeed(source, observation).doStream(params)).stream);
  assert.equal(resolveModelSpeedResult(observation), "downgraded");
});

test("request-local observations never inherit a previous request's confirmation", async () => {
  const first: ModelSpeedObservation = { requested: "fast" };
  const second: ModelSpeedObservation = { requested: "fast" };
  await observeModelSpeed(sdkModel({ service_tier: "priority" }), first).doGenerate(params);
  await observeModelSpeed(sdkModel({}), second).doGenerate(params);
  assert.equal(resolveModelSpeedResult(first), "confirmed");
  assert.equal(resolveModelSpeedResult(second), "unconfirmed");
});

test("an explicit unknown final tier clears an earlier confirmation", async () => {
  const observation: ModelSpeedObservation = { requested: "fast" };
  const source = sdkModel(undefined, [
    { service_tier: "priority" },
    { service_tier: "unknown-tier" },
  ]);
  await readStream((await observeModelSpeed(source, observation).doStream(params)).stream);
  assert.equal(resolveModelSpeedResult(observation), "unconfirmed");
});

test("standard selection served as fast is a mismatch, not confirmed", () => {
  assert.equal(
    resolveModelSpeedResult({ requested: "standard", responseTier: "priority" }),
    "mismatch",
  );
  assert.equal(
    resolveModelSpeedResult({ requested: "standard", responseTier: "on_demand" }),
    "confirmed",
  );
  assert.equal(resolveModelSpeedResult({ requested: "fast", responseTier: "auto" }), "unconfirmed");
});

test("stream cancellation reaches the original stream", async () => {
  let cancelled = false;
  const source = sdkModel(undefined);
  source.doStream = async () => ({
    stream: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  });
  const result = await observeModelSpeed(source, { requested: "fast" }).doStream(params);
  await result.stream.cancel("stopped");
  assert.equal(cancelled, true);
});

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
