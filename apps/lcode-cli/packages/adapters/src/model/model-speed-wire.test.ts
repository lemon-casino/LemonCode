import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateText, streamText } from "ai";
import {
  parseLCodeBuiltinModelConfigRules,
  parseProviderConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { resolveModelSpeedResult } from "./model-speed-observation.js";

const source = JSON.parse(await readFile("config/provider/lcode-builtin.json", "utf8"));
const rules = parseLCodeBuiltinModelConfigRules(source.config.modelConfigRules);
const apiTypes = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;
type ApiType = (typeof apiTypes)[number];

for (const apiType of apiTypes) {
  for (const streaming of [false, true]) {
    for (const tier of ["fast", "standard", undefined]) {
      test(`${apiType} ${streaming ? "stream" : "generate"}: wire request and served ${tier ?? "unknown"}`, async () => {
        let requests = 0;
        let actualBody: Record<string, unknown> = {};
        let actualHeaders = new Headers();
        const modelId = "test-model";
        const api = { type: apiType, baseUrl: "https://relay.example.test/v1" };
        const config = rules.resolve({
          providerId: "test-relay",
          modelId,
          apiType,
          baseUrl: api.baseUrl,
        });
        const specs = config.optionSpecs!;
        const execution = new AiSdkModelExecution(
          {},
          {
            transport: async (input, init) => {
              requests += 1;
              const request = new Request(input, init);
              actualBody = (await request.json()) as Record<string, unknown>;
              actualHeaders = request.headers;
              return providerResponse(apiType, streaming, tier);
            },
          },
        );
        const binding = execution
          .bindModel({
            providerId: "test-relay",
            modelId,
            providerConfig: parseProviderConfig({
              group: "standard-personal",
              api,
              access: { type: "api-key", apiKey: "test-only" },
            }) as RegistryProviderConfig,
            supportsJsonSchemaOutput: false,
            optionSpecs: {
              reasoningLevel: { map: specs.reasoningLevel!.map! },
              maxOutputTokens: { map: specs.maxOutputTokens!.map! },
              speed: { map: specs.speed!.map! },
            },
          })
          .resolveRequest({
            options: { reasoningLevel: "high", maxOutputTokens: 1024, speed: "fast" },
          });
        const options = { model: binding.model, prompt: "ping", maxRetries: 0 };
        const text = streaming
          ? await streamText(options).text
          : (await generateText(options)).text;
        assert.equal(text, "pong");
        assert.equal(requests, 1, "speed detection must not retry a successful response");
        assert.equal(
          actualBody[apiType === "anthropic-messages" ? "speed" : "service_tier"],
          apiType === "anthropic-messages" ? "fast" : "priority",
        );
        if (apiType === "anthropic-messages")
          assert.match(actualHeaders.get("anthropic-beta") ?? "", /fast-mode-2026-02-01/);
        assert.equal(
          resolveModelSpeedResult(binding.speedObservation!),
          tier === "fast" ? "confirmed" : tier === "standard" ? "downgraded" : "unconfirmed",
        );
      });
    }
  }
}

function providerResponse(apiType: ApiType, streaming: boolean, tier?: string): Response {
  const serviceTier = tier === "fast" ? "priority" : tier === "standard" ? "default" : undefined;
  if (apiType === "openai-chat-completions") {
    const base = { id: "chat-test", created: 1, model: "test-model", service_tier: serviceTier };
    return streaming
      ? sse([
          {
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ])
      : Response.json({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
  }
  if (apiType === "openai-responses") {
    const response = {
      id: "resp_test",
      created_at: 1,
      model: "test-model",
      status: "completed",
      service_tier: serviceTier,
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          content: [{ type: "output_text", text: "pong", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    return streaming
      ? sse([
          {
            type: "response.created",
            response: { ...response, output: [], status: "in_progress", service_tier: "auto" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "msg_test", role: "assistant", content: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_test",
            output_index: 0,
            content_index: 0,
            delta: "pong",
          },
          { type: "response.output_item.done", output_index: 0, item: response.output[0] },
          { type: "response.completed", response },
        ])
      : Response.json(response);
  }
  const message = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    stop_reason: "end_turn",
    stop_sequence: null,
    content: [{ type: "text", text: "pong" }],
    usage: { input_tokens: 1, output_tokens: 1, speed: tier },
  };
  return streaming
    ? sse([
        { type: "message_start", message: { ...message, content: [], stop_reason: null } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ])
    : Response.json(message);
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
