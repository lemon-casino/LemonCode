import assert from "node:assert/strict";
import test from "node:test";
import { createModelId, createModelProviderId, type ModelInputMessage } from "@zcode/contracts";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";

function target(providerId: string, modelId: string) {
  return {
    providerId: createModelProviderId(providerId),
    modelId: createModelId(modelId),
  };
}

test("removes Anthropic signed reasoning when projecting history to OpenAI", () => {
  const messages: ModelInputMessage[] = [
    {
      role: "assistant",
      providerId: createModelProviderId("anthropic-account"),
      modelId: createModelId("claude"),
      content: [
        {
          type: "reasoning",
          text: "private thinking",
          providerOptions: { anthropic: { signature: "signed" } },
        },
        { type: "text", text: "portable answer" },
      ],
    },
  ];

  assert.deepEqual(normalizeReasoningHistory(messages, target("openai-account", "gpt")), [
    {
      role: "assistant",
      providerId: createModelProviderId("anthropic-account"),
      modelId: createModelId("claude"),
      content: [{ type: "text", text: "portable answer" }],
    },
  ]);
});

test("removes OpenAI reasoning references when projecting history to Anthropic", () => {
  const messages: ModelInputMessage[] = [
    {
      role: "assistant",
      providerId: createModelProviderId("openai-account"),
      modelId: createModelId("gpt"),
      content: [
        {
          type: "reasoning",
          text: "provider reasoning",
          providerOptions: { openai: { itemId: "reasoning-1" } },
        },
        { type: "text", text: "portable answer" },
      ],
    },
  ];

  assert.deepEqual(normalizeReasoningHistory(messages, target("anthropic-account", "claude")), [
    {
      role: "assistant",
      providerId: createModelProviderId("openai-account"),
      modelId: createModelId("gpt"),
      content: [{ type: "text", text: "portable answer" }],
    },
  ]);
});

test("preserves provider-neutral reasoning across models", () => {
  const messages: ModelInputMessage[] = [
    {
      role: "assistant",
      providerId: createModelProviderId("provider-a"),
      modelId: createModelId("model-a"),
      content: [
        { type: "reasoning", text: "portable reasoning" },
        { type: "text", text: "portable answer" },
      ],
    },
  ];

  assert.deepEqual(normalizeReasoningHistory(messages, target("provider-b", "model-b")), messages);
});

test("removes private reasoning metadata when legacy history has no model provenance", () => {
  const messages: ModelInputMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "private legacy reasoning",
          providerOptions: { openai: { itemId: "reasoning-legacy" } },
        },
        { type: "reasoning", text: "portable legacy reasoning" },
        { type: "text", text: "portable answer" },
      ],
    },
  ];

  assert.deepEqual(normalizeReasoningHistory(messages, target("anthropic-account", "claude")), [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "portable legacy reasoning" },
        { type: "text", text: "portable answer" },
      ],
    },
  ]);
});
