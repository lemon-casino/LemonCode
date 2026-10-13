import assert from "node:assert/strict";
import test from "node:test";
import { createProviderCatalogClient } from "./providerCatalogClient.js";
import type { ProviderConfigObject } from "@lcode/provider";

test("shared 429 pauses the remaining batch without marking keys invalid or timing out unsent keys", async () => {
  let sent = 0;
  const cancelled = new AbortController();
  const client = createProviderCatalogClient(async () => {
    sent++;
    return new Response(null, { status: 429, headers: { "retry-after": "120" } });
  });
  const config: ProviderConfigObject = {
    api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
    access: {
      type: "api-key",
      apiKeys: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        apiKey: `synthetic-${index}`,
        enabled: true,
      })),
    },
  };
  const results = await client.probeApiKeys(config, [], {
    signal: cancelled.signal,
    timeoutMs: 1,
    onProgress: (progress) => {
      if (progress.completed >= 8) cancelled.abort();
    },
  });
  assert.equal(sent, 8);
  assert.equal(results.length, 8);
  assert.equal(
    results.every((result) => result.status === "error" && result.message === "HTTP 429"),
    true,
  );
  client.dispose?.();
});

test("Key scoped 429 does not pause unrelated candidates or classify them as invalid", async () => {
  let sent = 0;
  const client = createProviderCatalogClient(async () => {
    sent++;
    return new Response(
      null,
      sent === 1
        ? { status: 429, headers: { "x-lcode-rate-limit-scope": "key", "retry-after": "120" } }
        : { status: 200 },
    );
  });
  const config: ProviderConfigObject = {
    api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
    access: {
      type: "api-key",
      apiKeys: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        apiKey: `synthetic-${index}`,
        enabled: true,
      })),
    },
  };
  try {
    const results = await client.probeApiKeys(config);
    assert.equal(sent, 100);
    assert.equal(results[0]?.status, "error");
    assert.equal(
      results.slice(1).every((result) => result.status === "valid"),
      true,
    );
  } finally {
    client.dispose?.();
  }
});

test("Catalog cooldown spans batches at the same endpoint and keeps other endpoints independent", async () => {
  const sent: string[] = [];
  const client = createProviderCatalogClient(async (input) => {
    const url = String(input);
    sent.push(url);
    return url.includes("limited.test")
      ? new Response(null, { status: 429, headers: { "retry-after": "120" } })
      : Response.json({ data: [{ id: "fixture" }] });
  });
  const config: ProviderConfigObject = {
    api: { type: "openai-chat-completions", baseUrl: "https://limited.test/v1" },
    access: { type: "api-key", apiKeys: [{ id: "fixture", apiKey: "synthetic", enabled: true }] },
  };
  try {
    await assert.rejects(client.listModels(config), /HTTP 429/u);
    const pending = client.listModels({ ...config }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.deepEqual(
      (
        await client.listModels({
          ...config,
          api: { ...config.api!, baseUrl: "https://other.test/v1" },
        })
      ).models,
      ["fixture"],
    );
    client.dispose?.();
    assert.equal(((await pending) as Error).name, "AbortError");
    assert.equal(sent.length, 2);
  } finally {
    client.dispose?.();
  }
});
