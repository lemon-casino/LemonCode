import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { type ModelInputMessage, type ModelResult, type ModelToolContract } from "@zcode/contracts";
import { toAiSdkMessages } from "./transform.js";
import { createUiTarsModelExecutor, type UiTarsAppRef } from "./ui-tars-model-executor.js";
import type { ModelExecutionRequest, ModelExecutor } from "./model.js";

const nodeReplTool: ModelToolContract = {
  name: "mcp__node_repl__js",
  inputSchema: { type: "object" },
};

const inputFormat = {
  supportsText: true,
  supportsImage: true,
  supportsVideo: false,
  supportsAudio: false,
  supportsPdf: false,
} as const;

test("second UI-TARS request keeps synthetic Thought out of all provider wire formats", async () => {
  const projected = await captureSecondStepProviderRequest();
  const cases = [
    {
      name: "Anthropic Messages",
      apiFormat: "anthropic-messages",
      providerKind: "anthropic" as const,
      createModel: (fetch: typeof globalThis.fetch) =>
        createAnthropic({ apiKey: "test", baseURL: "https://example.invalid", fetch })(
          "wire-model",
        ),
    },
    {
      name: "OpenAI Chat Completions",
      apiFormat: "openai-chat-completions",
      providerKind: "openai-compatible" as const,
      createModel: (fetch: typeof globalThis.fetch) =>
        createOpenAICompatible({
          name: "wire-test",
          apiKey: "test",
          baseURL: "https://example.invalid",
          fetch,
        })("wire-model"),
    },
    {
      name: "OpenAI Responses",
      apiFormat: "openai-responses",
      providerKind: "openai" as const,
      createModel: (fetch: typeof globalThis.fetch) =>
        createOpenAI({ apiKey: "test", baseURL: "https://example.invalid", fetch }).responses(
          "wire-model",
        ),
    },
  ];

  for (const providerCase of cases) {
    const messages = toAiSdkMessages(projected.messages, {
      apiFormat: providerCase.apiFormat,
      providerKind: providerCase.providerKind,
      inputFormat,
    });
    const body = await captureRequestBody(providerCase.createModel, messages);
    const wire = JSON.stringify(body);
    assert.doesNotMatch(wire, /"type":"thinking"/u, providerCase.name);
    assert.doesNotMatch(wire, /"signature":""/u, providerCase.name);
    assert.doesNotMatch(wire, /"reasoning_content"/u, providerCase.name);
    assert.doesNotMatch(wire, /"type":"reasoning"/u, providerCase.name);
  }
});

async function captureSecondStepProviderRequest(): Promise<ModelExecutionRequest> {
  const firstMessages: ModelInputMessage[] = [
    { role: "user", content: "Inspect" },
    officialFrame("before-action"),
  ];
  const firstResult = await createUiTarsModelExecutor(
    fixedExecutor({
      text: "Thought: inspect the target\nAction: wait()",
      finishReason: "stop",
      usage: {},
    }),
  ).generateText(request(firstMessages));

  const calls: ModelExecutionRequest[] = [];
  const secondExecutor: ModelExecutor = {
    async generateText(input) {
      calls.push(input);
      return {
        text: "Thought: done\nAction: finished(content='done')",
        finishReason: "stop",
        usage: {},
      };
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };
  await createUiTarsModelExecutor(secondExecutor).generateText(
    request([
      ...firstMessages,
      {
        role: "assistant",
        content: firstResult.reasoning ?? [],
        toolCalls: firstResult.toolCalls,
      },
      officialFrame("after-action"),
    ]),
  );
  assert.equal(calls.length, 1);
  return calls[0]!;
}

async function captureRequestBody(
  createModel: (fetch: typeof globalThis.fetch) => LanguageModel,
  messages: ModelMessage[],
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    throw new Error("request body captured");
  };
  await assert.rejects(
    generateText({
      model: createModel(fetch),
      messages,
      maxOutputTokens: 128,
      maxRetries: 0,
      allowSystemInMessages: true,
    }),
    /request body captured/u,
  );
  assert.ok(body);
  return body;
}

function fixedExecutor(result: ModelResult): ModelExecutor {
  return {
    async generateText() {
      return result;
    },
    streamText() {
      throw new Error("streamText should not be called");
    },
  };
}

function request(messages: ModelInputMessage[]): ModelExecutionRequest {
  return {
    messages,
    tools: [nodeReplTool],
    options: { maxOutputTokens: 1024, reasoningLevel: "none" },
  };
}

function officialFrame(frameId: string): ModelInputMessage {
  const appRef: UiTarsAppRef = { pid: 42, window_id: 7 };
  return {
    role: "tool",
    toolCallId: `observe-${frameId}`,
    toolName: nodeReplTool.name,
    content: [
      {
        type: "image",
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,cG5n",
      },
      {
        type: "text",
        text: JSON.stringify({
          type: "zcode_cua_frame_ref",
          schemaVersion: 1,
          authority: "zcode.cua/open-frame/test",
          frameId,
          contentProtection: "official_cua_frame_v1",
          mimeType: "image/png",
          width: 1000,
          height: 500,
          appRef,
        }),
      },
    ],
  };
}
