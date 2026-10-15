import assert from "node:assert/strict";
import test from "node:test";
import { createProviderCatalogClient } from "./providerCatalogClient.js";

const config = {
  group: "standard-personal",
  access: {
    type: "api-key",
    apiKey: "bad",
    apiKeys: [
      { id: "bad", apiKey: "bad", enabled: true },
      { id: "good", apiKey: "good", enabled: true },
    ],
  },
  api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
} as const;

test("model catalog falls through to the next key on authentication failure", async () => {
  const authorizations: string[] = [];
  const client = createProviderCatalogClient(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    authorizations.push(authorization);
    return authorization.endsWith("bad")
      ? new Response(null, { status: 401 })
      : Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] });
  });
  assert.deepEqual(await client.listModels(config), { models: ["model-b", "model-a"] });
  assert.deepEqual(authorizations, ["Bearer bad", "Bearer good"]);
});

test("api key probe distinguishes invalid credentials from provider errors", async () => {
  const client = createProviderCatalogClient(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    return authorization.endsWith("bad")
      ? new Response(null, { status: 403 })
      : new Response(null, { status: 500 });
  });
  assert.deepEqual(await client.probeApiKeys(config), [
    { keyId: "bad", status: "invalid", message: "HTTP 403" },
    { keyId: "good", status: "error", message: "HTTP 500" },
  ]);
});

test("disposed catalog rejects before resolving a new transport", async () => {
  let resolved = 0;
  const client = createProviderCatalogClient(undefined, () => {
    resolved++;
    return fetch;
  });
  client.dispose!();
  await assert.rejects(client.listModels(config), { name: "AbortError" });
  await assert.rejects(client.probeApiKeys(config), { name: "AbortError" });
  assert.equal(resolved, 0);
});

test("catalog close waits late headers, cancels their body and never publishes late models", async () => {
  const entered = Promise.withResolvers<void>(),
    reply = Promise.withResolvers<Response>();
  let cancels = 0,
    closed = false;
  const client = createProviderCatalogClient(async () => {
    entered.resolve();
    return reply.promise;
  });
  const listing = assert.rejects(client.listModels(config), { name: "AbortError" });
  await entered.promise;
  const closing = client.disposeAndWait!().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
  } finally {
    reply.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancels++;
          },
        }),
      ),
    );
    await Promise.all([listing, closing]);
  }
  assert.equal(cancels, 1);
});

test("catalog exposes physical body cancellation failure and does not consume another key", async () => {
  let calls = 0;
  const client = createProviderCatalogClient(async () => {
    calls++;
    return new Response(
      new ReadableStream({
        cancel() {
          throw new Error("fixture body cleanup");
        },
      }),
      { status: 401 },
    );
  });
  await assert.rejects(client.listModels(config), /fixture body cleanup/);
  await assert.rejects(client.disposeAndWait!(), AggregateError);
  assert.equal(calls, 1);
});
