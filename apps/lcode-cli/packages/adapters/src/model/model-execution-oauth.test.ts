import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfig, createRegistryProviderConfig } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";

test("OAuth binding uses the Host request endpoint and model wire protocol without persisting credentials", async () => {
  const requests: Request[] = [];
  const execution = new AiSdkModelExecution(
    { env: {} },
    {
      transport: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(
          JSON.stringify({
            id: "completion",
            choices: [
              {
                message: { role: "assistant", content: "actual fixture response" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  const parsed = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "oauth-account", channelId: "copilot" },
      api: { type: "anthropic-messages", baseUrl: "https://oauth.invalid/v1" },
    }),
  );
  assert.ok(parsed.ok);
  const binding = execution.bindModel({
    providerId: "oauth:copilot",
    modelId: "fixture-model",
    providerConfig: parsed.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      reasoningLevel: { map: '{"reasoning_effort": reasoningLevel}' },
      maxOutputTokens: { map: '{"max_tokens": maxOutputTokens}' },
    },
  });
  const resolved = binding.resolveRequest({
    options: { reasoningLevel: "high", maxOutputTokens: 64 },
    requestAuth: {
      apiKey: "ephemeral-ticket",
      baseURL: "http://127.0.0.1:19731/v1",
      protocol: "openai-chat-completions",
    },
  });
  assert.equal(resolved.providerKind, "openai-compatible");
  assert.equal(typeof resolved.model, "object");
  const output = await (
    resolved.model as unknown as {
      doGenerate(input: unknown): Promise<{ content: unknown; usage: unknown }>;
    }
  ).doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    maxOutputTokens: 32,
    headers: {},
  });
  assert.equal(requests[0]!.url, "http://127.0.0.1:19731/v1/chat/completions");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer ephemeral-ticket");
  const body = await requests[0]!.json();
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.max_tokens, 64);
  assert.match(JSON.stringify(output.content), /actual fixture response/u);
  assert.equal(parsed.config.api.baseUrl, "https://oauth.invalid/v1");
  assert.equal(JSON.stringify(parsed.config).includes("ephemeral-ticket"), false);
});
