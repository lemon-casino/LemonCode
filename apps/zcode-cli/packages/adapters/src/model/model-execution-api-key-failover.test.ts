import assert from "node:assert/strict";
import test from "node:test";
import { createApiKeyFailoverFetch } from "./model-execution.js";

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
