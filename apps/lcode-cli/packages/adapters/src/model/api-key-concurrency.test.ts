import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkModelExecution, createApiKeyFailoverFetch } from "./model-execution.js";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryProviderConfig,
} from "@lcode/provider";

const keys = ["a", "b", "c"].map((id) => ({ id, apiKey: `fixture-${id}`, enabled: true }));
const readKey = (input: RequestInfo | URL) =>
  new Request(input).headers.get("authorization")!.slice(-1);

test("concurrent requests reserve different keys before responses complete", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const selected: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    keys,
    providerKind: "openai-compatible",
    fetch: async (input) => {
      selected.push(readKey(input));
      if (selected.length === 3) entered();
      await gate;
      return new Response("ok");
    },
  });
  const requests = Array.from({ length: 3 }, () => fetch("https://example.test/model"));
  await entering;
  release();
  const responses = await Promise.all(requests);
  await Promise.all(responses.map((response) => response.text()));
  assert.deepEqual(selected, ["a", "b", "c"]);
});

test("a key failed by a concurrent request is not retried through an old candidate snapshot", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    keys,
    providerKind: "openai-compatible",
    fetch: async (input) => {
      const id = readKey(input);
      calls.push(id);
      if (calls.length === 1) {
        entered();
        await gate;
      }
      return new Response(id, { status: id === "c" ? 200 : 401 });
    },
  });
  const first = fetch("https://example.test/model");
  await entering;
  const second = await fetch("https://example.test/model");
  await second.text();
  release();
  await (await first).text();
  assert.equal(calls.filter((id) => id === "b").length, 1);
  assert.deepEqual(calls, ["a", "b", "c", "c"]);
});

test("pre-cancelled requests do not advance the key cursor", async () => {
  const calls: string[] = [];
  const fetch = createApiKeyFailoverFetch({
    keys,
    providerKind: "openai-compatible",
    fetch: async (input) => {
      calls.push(readKey(input));
      return new Response("ok");
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetch("https://example.test/model", { signal: controller.signal }), {
    name: "AbortError",
  });
  await (await fetch("https://example.test/model")).text();
  assert.deepEqual(calls, ["a"]);
});

test("a disabled nonempty key list cannot fall back to legacy or environment credentials", () => {
  const execution = new AiSdkModelExecution(
    {},
    {
      transport: async () => {
        throw new Error("must not send");
      },
    },
  );
  try {
    const providerConfig = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({
        apiKey: "fixture-legacy",
        apiKeys: [{ ...keys[0]!, enabled: false }],
      }),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://example.test",
      }),
    }) as RegistryProviderConfig;
    assert.throws(
      () =>
        execution.bindModel({
          providerId: "fixture",
          modelId: "fixture",
          providerConfig,
          supportsJsonSchemaOutput: false,
          optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
        }),
      /enabled API key/i,
    );
  } finally {
    execution.dispose();
  }
});
