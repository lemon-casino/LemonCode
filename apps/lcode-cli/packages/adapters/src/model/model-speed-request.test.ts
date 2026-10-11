import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  parseLCodeBuiltinModelConfigRules,
  type RegistryProviderConfig,
} from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";

const source = JSON.parse(
  await readFile(resolve(process.cwd(), "config/provider/lcode-builtin.json"), "utf8"),
) as { config: { modelConfigRules: unknown } };
const rules = parseLCodeBuiltinModelConfigRules(source.config.modelConfigRules);

type ApiType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

function modelConfig(apiType: ApiType, modelId: string, baseUrl = "https://example.test/v1") {
  const config = rules.resolve({
    providerId: "user-custom-provider",
    modelId,
    apiType,
    baseUrl,
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
  assert.deepEqual(
    modelConfig("openai-responses", "grok-4.7").optionSpecs?.reasoningLevel?.values,
    ["low", "medium", "high", "xhigh"],
  );
  // 新型号不能落回通用 disabled（映射成 none）；单项/批量检测均取这里的最低项。
  for (const apiType of ["openai-chat-completions", "openai-responses"] as const) {
    for (const modelId of ["gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-6.1-sol:custom"]) {
      assert.deepEqual(modelConfig(apiType, modelId).optionSpecs?.reasoningLevel?.values, [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    for (const modelId of ["gpt-6.1", "gpt-6.1-luna", "gpt-6.1-solstice"]) {
      assert.equal(
        modelConfig(apiType, modelId).optionSpecs?.reasoningLevel?.values?.[0],
        "disabled",
      );
    }
  }
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
    const binding = execution
      .bindModel({
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
      })
      .resolveRequest({
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
    const { compileModelOptionMaps } = await import("@lcode/model-option-map");
    const specs = config.optionSpecs!;
    const maps = compileModelOptionMaps({
      reasoningLevel: { map: specs.reasoningLevel!.map! },
      maxOutputTokens: { map: specs.maxOutputTokens!.map! },
      speed: { map: specs.speed!.map! },
    });
    const body = maps.apply(
      { [expectedField]: expectedValue },
      {
        reasoningLevel: "high",
        maxOutputTokens: 2048,
        speed: "standard",
      },
    );
    assert.equal(body[expectedField], undefined);
    if (apiType !== "anthropic-messages") {
      const specs = modelConfig(apiType, "gpt-6.1-sol").optionSpecs!;
      const options = {
        reasoningLevel: specs.reasoningLevel!.values![0]!,
        maxOutputTokens: specs.maxOutputTokens!.max!,
        speed: specs.speed!.values![0]!,
      };
      const maps = compileModelOptionMaps({
        reasoningLevel: { map: specs.reasoningLevel!.map! },
        maxOutputTokens: { map: specs.maxOutputTokens!.map! },
        speed: { map: specs.speed!.map! },
      });
      const probeBody = maps.apply({}, options);
      assert.equal(options.reasoningLevel, "low");
      assert.deepEqual({ ...(probeBody.reasoning as Record<string, unknown>) }, { effort: "low" });
      if (apiType === "openai-chat-completions") assert.equal(probeBody.reasoning_effort, "low");
      assert.equal(probeBody[expectedField], undefined);
    }
  });
}

test("official speed capabilities override protocol defaults without changing relay capabilities", () => {
  // Bug 原因：协议兼容曾被当成快速档能力，导致不支持的官方模型也默认发 fast。
  for (const baseUrl of [
    "https://api.z.ai/api/anthropic",
    "https://open.bigmodel.cn/api/paas/v4",
    "https://api.moonshot.cn/anthropic",
    "https://api.minimaxi.com/anthropic",
    "https://api.deepseek.com/anthropic",
    "https://dashscope.aliyuncs.com/apps/anthropic",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "https://api.xiaomimimo.com/anthropic",
  ]) {
    for (const apiType of ["anthropic-messages", "openai-chat-completions"] as const) {
      assert.deepEqual(
        modelConfig(apiType, "custom-model", baseUrl).optionSpecs?.speed?.values,
        ["standard"],
        baseUrl,
      );
    }
  }
  for (const modelId of ["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5-20260901"]) {
    assert.deepEqual(
      modelConfig("anthropic-messages", modelId, "https://api.anthropic.com/v1/").optionSpecs?.speed
        ?.values,
      ["standard", "fast"],
    );
  }
  for (const modelId of [
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-5-6",
  ]) {
    assert.deepEqual(
      modelConfig("anthropic-messages", modelId, "https://api.anthropic.com/v1").optionSpecs?.speed
        ?.values,
      ["standard"],
    );
  }
  assert.deepEqual(
    modelConfig("anthropic-messages", "claude-opus-4-6").optionSpecs?.speed?.values,
    ["standard", "fast"],
  );
  assert.deepEqual(
    modelConfig("openai-responses", "gpt-6.1-sol", "https://api.openai.com.relay.test/v1")
      .optionSpecs?.speed?.values,
    ["standard", "fast"],
  );
});

test("official service tiers use each vendor's wire values", async () => {
  const { compileModelOptionMaps } = await import("@lcode/model-option-map");
  for (const [apiType, modelId, baseUrl, fast, standard] of [
    ["openai-responses", "gpt-6.1-sol", "https://api.openai.com/v1", "priority", "default"],
    ["openai-chat-completions", "gpt-6.1-sol", "https://api.openai.com/v1/", "priority", "default"],
    ["openai-responses", "grok-4.7", "https://api.x.ai/v1", "priority", undefined],
    [
      "openai-chat-completions",
      "gemini-3.8-flash",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "priority",
      undefined,
    ],
    [
      "openai-chat-completions",
      "openai/gpt-oss-120b",
      "https://api.groq.com/openai/v1",
      "performance",
      "on_demand",
    ],
  ] as const) {
    const specs = modelConfig(apiType, modelId, baseUrl).optionSpecs!;
    const maps = compileModelOptionMaps({
      reasoningLevel: { map: specs.reasoningLevel!.map! },
      maxOutputTokens: { map: specs.maxOutputTokens!.map! },
      speed: { map: specs.speed!.map! },
    });
    for (const [speed, expected] of [
      ["fast", fast],
      ["standard", standard],
    ] as const) {
      assert.equal(
        maps.apply(
          {},
          {
            reasoningLevel: specs.reasoningLevel!.values![0]!,
            maxOutputTokens: 1024,
            speed,
          },
        ).service_tier,
        expected,
        baseUrl,
      );
    }
  }
});

test("Groq limits performance to supported models and OpenAI excludes fine-tuning", () => {
  for (const modelId of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"]) {
    assert.deepEqual(
      modelConfig("openai-chat-completions", modelId, "https://api.groq.com/openai/v1").optionSpecs
        ?.speed?.values,
      ["standard", "fast"],
    );
  }
  assert.deepEqual(
    modelConfig("openai-chat-completions", "llama-3.1-8b-instant", "https://api.groq.com/openai/v1")
      .optionSpecs?.speed?.values,
    ["standard"],
  );
  assert.deepEqual(
    modelConfig("openai-responses", "ft:gpt-4.1:example:custom:id", "https://api.openai.com/v1")
      .optionSpecs?.speed?.values,
    ["standard"],
  );
});
