import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  createModelUsageSummary,
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  getModelUsageTotalTokens,
  hasModelUsage,
  ModelErrorCode,
  ModelFailureReason,
  modelInputMessageJsonSchema,
  modelMessageContentToText,
  modelNetworkStatusEventJsonSchema,
  ModelProtocolError,
  ModelRetryBudget,
  ModelRetryReason,
  modelSelectionJsonSchema,
  modelTextRequestJsonSchema,
} from "./index.js";
import type { ModelMessageContentBlock, ModelToolCall, ToolCall } from "./index.js";

test("branded model identities and error constructor retain public behavior", () => {
  assert.equal(createModelProviderId(" provider "), "provider");
  assert.equal(createModelId(" model "), "model");
  for (const create of [createModelProviderId, createModelId]) {
    assert.throws(
      () => create("  "),
      (error) => {
        assert.ok(error instanceof ModelProtocolError);
        assert.equal(error.code, ModelErrorCode.InvalidModelSelection);
        assert.equal(error.name, "ModelProtocolError");
        return true;
      },
    );
  }
  const context = { source: "test" };
  const error = new ModelProtocolError(ModelErrorCode.InvalidModelRequest, "invalid", context);
  assert.equal(error.context, context);
  assert.equal(ModelProtocolError.length, 3);
  assert.deepEqual(ModelRetryBudget, { Default: "default", Unbounded: "unbounded" });
  assert.equal(ModelFailureReason.RateLimited, ModelRetryReason.RateLimited);
});

test("content conversion retains attachment placeholders and hides reasoning", () => {
  const tool: ToolCall = { id: "tool", name: "Read", input: {} } satisfies ModelToolCall;
  assert.equal(tool.name, "Read");
  const content: ModelMessageContentBlock[] = [
    { type: "text", text: "visible" },
    { type: "reasoning", text: "private reasoning" },
    {
      type: "image",
      mediaType: "image/png",
      dataUrl: "data:",
      source: { id: "image", kind: "inline", placeholder: "image" },
    },
    { type: "video", mediaType: "video/mp4", dataUrl: "data:" },
    { type: "file", mediaType: "text/plain", name: "file", text: "contents" },
    { type: "file", mediaType: "application/pdf", name: "report.pdf" },
    { type: "resource_link", uri: "resource:test", title: "reference" },
  ];
  assert.equal(
    modelMessageContentToText(content),
    [
      "visible",
      "[Attached image/png: image]",
      "[Attached video/mp4]",
      "contents",
      "[Attached application/pdf: report.pdf]",
      "[Resource: reference]",
    ].join("\n\n"),
  );
  assert.equal(modelMessageContentToText("plain"), "plain");
});

test("usage helpers preserve cache accounting, fallbacks and readonly aggregation", () => {
  assert.equal(getModelUsageInputWindowTokens({ inputTokens: 100, cacheReadTokens: 80 }), 100);
  assert.equal(
    getModelUsageContextTokens({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 80 }),
    125,
  );
  assert.equal(getModelUsageInputWindowTokens({ totalTokens: 120, outputTokens: 20 }), 100);
  assert.equal(
    getModelUsageInputWindowTokens({ cacheReadTokens: 10.9, cacheWriteTokens: 5.9 }),
    15,
  );
  assert.equal(
    getModelUsageContextTokens({ inputTokens: Number.NaN, outputTokens: -3 }),
    undefined,
  );
  assert.equal(getModelUsageContextTokens(), undefined);
  assert.equal(getModelUsageTotalTokens(), 0);
  assert.equal(
    getModelUsageTotalTokens({ cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 2 }),
    17,
  );
  assert.equal(hasModelUsage({}), false);
  assert.equal(hasModelUsage({ outputTokens: 0 }), true);
  assert.equal(createModelUsageSummary([]), undefined);
  const usages = [
    {},
    { inputTokens: 10, outputTokens: 2 },
    { serverToolUse: { webFetchRequests: 1 } },
  ] as const;
  assert.deepEqual(createModelUsageSummary(usages), {
    source: "provider",
    modelRequestCount: 2,
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 1,
  });
});

test("JSON schemas retain shared references and exclude runtime-only request fields", () => {
  assert.equal(modelTextRequestJsonSchema.properties.messages.items, modelInputMessageJsonSchema);
  assert.equal(modelNetworkStatusEventJsonSchema.properties.model, modelSelectionJsonSchema);
  assert.equal(modelNetworkStatusEventJsonSchema.properties.maxAttempts.minimum, 0);
  assert.deepEqual(modelSelectionJsonSchema.required, ["providerId", "modelId"]);
  assert.equal(modelTextRequestJsonSchema.additionalProperties, false);
  for (const name of [
    "statusSink",
    "traceContext",
    "modelRequestAdmission",
    "modelRetryBudget",
    "shouldYieldRetryToFailover",
  ]) {
    assert.equal(Object.hasOwn(modelTextRequestJsonSchema.properties, name), false);
  }
});
