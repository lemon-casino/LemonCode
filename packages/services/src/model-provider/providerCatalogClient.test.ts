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
