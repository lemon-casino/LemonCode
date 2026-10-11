import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import type { Logger, ModelId, ModelProviderId } from "@lcode/contracts";
import type { ResolvedAiSdkModel } from "./runner-runtime.js";
import { createStatusContext } from "./runner-status.js";
import { logModelSpeedObservation } from "./runner-speed-observation.js";

test("speed diagnostics retain request attribution without response content or endpoint", () => {
  const events: { level: string; context: unknown }[] = [];
  const logger: Logger = {
    debug() {},
    info(_message, context) {
      events.push({ level: "info", context });
    },
    warn(_message, context) {
      events.push({ level: "warn", context });
    },
    error() {},
    child() {
      return logger;
    },
  };
  const resolved: ResolvedAiSdkModel = {
    model: createOpenAI({ apiKey: "test-only" }).responses("test-model"),
    providerId: "test-provider" as ModelProviderId,
    modelId: "test-model" as ModelId,
    providerKind: "openai",
    baseURL: "https://private-endpoint.example.test/v1",
    rawRequestBodyCapture: { body: { service_tier: "priority", input: "private prompt" } },
    speedObservation: { requested: "fast" },
    properties: {
      contextWindow: 4096,
      requiresMfjsToolSchema: false,
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
  };
  const statusContext = createStatusContext({
    resolved,
    maxAttempts: 1,
    transport: "sse",
    request: {
      messages: [],
      metadata: { requestId: "test-request", sessionId: "test-session", traceId: "test-trace" },
    },
  });
  for (const responseTier of ["priority", "default", undefined]) {
    resolved.speedObservation!.responseTier = responseTier;
    logModelSpeedObservation({ logger, resolved, statusContext, attempt: 1 });
  }
  assert.deepEqual(
    events.map((event) => event.level),
    ["info", "warn", "warn"],
  );
  for (const [index, event] of events.entries()) {
    const context = event.context as Record<string, unknown>;
    assert.equal(context.speedResult, ["confirmed", "downgraded", "unconfirmed"][index]);
    assert.equal(context.sentServiceTier, "priority");
    assert.equal(context.requestId, "test-request");
    assert.equal(context.traceId, "test-trace");
    assert.equal(context.sessionId, "test-session");
    assert.doesNotMatch(JSON.stringify(context), /private-endpoint|private prompt|test-only/);
  }
});
