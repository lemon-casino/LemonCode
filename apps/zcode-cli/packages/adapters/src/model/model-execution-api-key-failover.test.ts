import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelExecution, createApiKeyFailoverFetch } from "./model-execution.js";

const keys = [
  { id: "bad", apiKey: "bad", enabled: true },
  { id: "good", apiKey: "good", enabled: true },
];

test("401 retries with the next key and remembers the failed key", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys,
    fetch: async (input) => {
      const authorization = new Request(input).headers.get("authorization") ?? "";
      calls.push(authorization);
      return authorization.endsWith("bad")
        ? new Response(null, { status: 401 })
        : new Response("ok", { status: 200 });
    },
  });
  assert.equal((await fetch("https://example.test/chat")).status, 200);
  assert.equal((await fetch("https://example.test/chat")).status, 200);
  assert.deepEqual(calls, ["Bearer bad", "Bearer good", "Bearer good"]);
});

test("500 does not rotate keys", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys,
    fetch: async (input) => {
      calls.push(new Request(input).headers.get("authorization") ?? "");
      return new Response(null, { status: 500 });
    },
  });
  assert.equal((await fetch("https://example.test/chat")).status, 500);
  assert.deepEqual(calls, ["Bearer bad"]);
});

test("successful requests round-robin enabled keys", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    providerKind: "openai-compatible",
    keys: [
      { id: "one", apiKey: "one", enabled: true },
      { id: "two", apiKey: "two", enabled: true },
    ],
    fetch: async (input) => {
      calls.push(new Request(input).headers.get("authorization") ?? "");
      return new Response("ok");
    },
  });
  await fetch("https://example.test/chat");
  await fetch("https://example.test/chat");
  await fetch("https://example.test/chat");
  assert.deepEqual(calls, ["Bearer one", "Bearer two", "Bearer one"]);
});

const unchangedKeys = [
  { id: "bad", apiKey: "cipher-bad", enabled: true },
  { id: "good", apiKey: "cipher-good", enabled: true },
];

function providerConfig(): RegistryProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({
      apiKey: unchangedKeys[0]?.apiKey,
      apiKeys: unchangedKeys,
    }),
    api: new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: "https://example.test/v1",
    }),
  }) as RegistryProviderConfig;
}

const optionSpecs = {
  reasoningLevel: { map: "{}" },
  maxOutputTokens: { map: "{}" },
};

function bindProvider(
  execution: AiSdkModelExecution,
  providerId: string,
  saveGeneration: string | undefined,
) {
  const model = execution
    .bindModel({
      providerId,
      modelId: "demo",
      providerConfig: providerConfig(),
      ...(saveGeneration === undefined ? {} : { providerSaveGeneration: saveGeneration }),
      supportsJsonSchemaOutput: false,
      optionSpecs,
    })
    .resolveRequest({ options: { reasoningLevel: "off", maxOutputTokens: 16 } }).model;
  if (typeof model === "string") throw new Error("Expected a bound language model");
  return model as unknown as { doGenerate(input: never): Promise<unknown> };
}

function bindKeys(
  execution: AiSdkModelExecution,
  saveGeneration: string | undefined,
) {
  return bindProvider(execution, "custom", saveGeneration);
}

async function generate(model: { doGenerate(input: never): Promise<unknown> }): Promise<void> {
  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    maxOutputTokens: 16,
    headers: {},
  } as never);
}

test("a new frozen save generation clears failed keys and the same generation keeps skipping", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const authorization = new Request(input).headers.get("authorization") ?? "";
        calls.push(authorization);
        return authorization.endsWith("cipher-bad")
          ? new Response(null, { status: 401 })
          : new Response(
              JSON.stringify({
                id: "cmpl",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    },
  );
  const first = bindKeys(execution, "save-1");
  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-good"]);

  calls.length = 0;
  const saved = bindKeys(execution, "save-2");
  await generate(saved);
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await generate(saved);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});

test("saving another provider keeps this provider's failed keys", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        const authorization = new Request(input).headers.get("authorization") ?? "";
        calls.push(authorization);
        return authorization.endsWith("cipher-bad")
          ? new Response(null, { status: 401 })
          : new Response(
              JSON.stringify({
                id: "cmpl",
                choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
      },
    },
  );
  const first = bindKeys(execution, "save-a");
  await generate(first);
  calls.length = 0;

  const otherProvider = bindProvider(execution, "other-provider", "save-b");
  await generate(otherProvider);
  calls.length = 0;

  await generate(first);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
  calls.length = 0;
  const sameGeneration = bindKeys(execution, "save-a");
  await generate(sameGeneration);
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});

test("all failed keys send one request", async () => {
  const calls: string[] = [];
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async (input) => {
        calls.push(new Request(input).headers.get("authorization") ?? "");
        return new Response(null, { status: 401 });
      },
    },
  );
  const model = bindKeys(execution, "save-1");
  await assert.rejects(generate(model));
  assert.deepEqual(calls, ["Bearer cipher-bad", "Bearer cipher-good"]);
  calls.length = 0;
  await assert.rejects(generate(model));
  assert.deepEqual(calls, ["Bearer cipher-good"]);
});
