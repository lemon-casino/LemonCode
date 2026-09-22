import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  parseZCodeBuiltinModelConfigRules,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";

const source = JSON.parse(
  await readFile(resolve(process.cwd(), "config/provider/zcode-builtin.json"), "utf8"),
) as { config: { modelConfigRules: unknown } };
const rules = parseZCodeBuiltinModelConfigRules(source.config.modelConfigRules);

type ApiType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

function modelConfig(apiType: ApiType, modelId: string) {
  const config = rules.resolve({
    providerId: "user-custom-provider",
    modelId,
    apiType,
    baseUrl: "https://example.test/v1",
  });
  const issues = config.validateComplete();
  assert.deepEqual(issues, []);
  return config;
}

test("custom providers inherit multilevel reasoning and speed from the built-in rules", () => {
  for (const apiType of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    const config = modelConfig(apiType, "custom-reasoning-model");
    assert.deepEqual(config.optionSpecs?.reasoningLevel?.values, [
      "disabled",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.deepEqual(config.optionSpecs?.speed?.values, ["standard", "fast"]);
  }
  assert.deepEqual(modelConfig("openai-responses", "grok-4.7").optionSpecs?.reasoningLevel?.values, [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

for (const [apiType, expectedField, expectedValue] of [
  ["anthropic-messages", "speed", "fast"],
  ["openai-chat-completions", "service_tier", "priority"],
  ["openai-responses", "service_tier", "priority"],
] as const) {
  test(`${apiType} sends selected speed through the actual adapter fetch`, async () => {
    const config = modelConfig(apiType, "custom-reasoning-model");
    const optionSpecs = config.optionSpecs!;
    let capturedHeader: string | null = null;
    const execution = new AiSdkModelExecution(
      {},
      {
        transport: async (input, init) => {
          const headers = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
          capturedHeader = headers.get("anthropic-beta");
          return new Response('{"error":{"message":"intercepted"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    const binding = execution.bindModel({
      providerId: "user-custom-provider",
      modelId: "custom-reasoning-model",
      providerConfig: new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({ apiKey: "test-only-key" }),
        api: new ProviderApiConfig({ type: apiType, baseUrl: "https://example.test/v1" }),
      }) as RegistryProviderConfig,
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: optionSpecs.reasoningLevel!.map! },
        maxOutputTokens: { map: optionSpecs.maxOutputTokens!.map! },
        speed: { map: optionSpecs.speed!.map! },
      },
    }).resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 2048, speed: "fast" },
    });
    const model = binding.model as unknown as { doGenerate(input: never): Promise<unknown> };
    await assert.rejects(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        maxOutputTokens: 2048,
        headers: {},
      } as never),
    );
    const body = binding.rawRequestBodyCapture?.body;
    assert.equal(body?.[expectedField], expectedValue);
    assert.equal(
      apiType === "anthropic-messages"
        ? String(capturedHeader).includes("fast-mode-2026-02-01")
        : capturedHeader,
      apiType === "anthropic-messages" ? true : null,
    );
  });

  test(`${apiType} keeps standard requests compatible with default endpoints`, async () => {
    const config = modelConfig(apiType, "custom-reasoning-model");
    const { compileModelOptionMaps } = await import("@zcode/model-option-map");
    const specs = config.optionSpecs!;
    const maps = compileModelOptionMaps({
      reasoningLevel: { map: specs.reasoningLevel!.map! },
      maxOutputTokens: { map: specs.maxOutputTokens!.map! },
      speed: { map: specs.speed!.map! },
    });
    const body = maps.apply({}, {
      reasoningLevel: "high",
      maxOutputTokens: 2048,
      speed: "standard",
    });
    assert.equal(body[expectedField], undefined);
  });
}
