import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
} from "@zcode/contracts";
import { runGenerateText } from "./runner-generate.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { runStreamText } from "./runner-stream.js";

const resolved = {
  model: {},
  modelId: createModelId("model-a"),
  providerId: createModelProviderId("provider-a"),
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

const retry = {
  backoffFactor: 1,
  baseDelayMs: 0,
  jitter: false,
  maxAttempts: 1,
  maxDelayMs: 0,
};

function request(): AiSdkModelTextRequest {
  return {
    messages: [{ content: "continue", role: "user" }],
    refreshRuntimeHeadersBeforeAttempt: async () => ({ headersApplied: false }),
  };
}

function assertAuthMissing(error: unknown): boolean {
  assert.ok(error instanceof ModelProtocolError);
  assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
  assert.equal(error.context?.reason, ModelFailureReason.AuthFailed);
  return true;
}

test("generate preserves a failed runtime-header refresh as structured authentication failure", async () => {
  let providerCalls = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      providerCalls += 1;
      throw new Error("generateText should not be called");
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(
    runGenerateText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
    }),
    assertAuthMissing,
  );

  assert.equal(providerCalls, 0);
});

test("stream preserves a failed runtime-header refresh as structured authentication failure", async () => {
  let providerCalls = 0;
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("generateText should not be called");
    },
    streamText() {
      providerCalls += 1;
      throw new Error("streamText should not be called");
    },
  };

  await assert.rejects(async () => {
    for await (const _event of runStreamText({
      env: {},
      modelIoFullRetentionEnabled: false,
      request: request(),
      resolveModel: () => resolved,
      resolved,
      retry,
      runtime,
      streamIdleTimeoutMs: 1_000,
    })) {
      // Runtime headers fail before the provider stream starts.
    }
  }, assertAuthMissing);

  assert.equal(providerCalls, 0);
});
