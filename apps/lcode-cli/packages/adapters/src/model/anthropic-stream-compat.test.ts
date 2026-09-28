import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicCompatFetch } from "./anthropic-stream-compat.js";

test("fast Anthropic requests include the Fast mode beta header", async () => {
  let capturedHeader: string | null = null;
  const fetch = createAnthropicCompatFetch(
    async (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      capturedHeader = headers.get("anthropic-beta");
      return new Response("ok");
    },
    { speed: "fast" },
  );

  await fetch("https://example.test/v1/messages", {
    method: "POST",
    headers: { "anthropic-beta": "existing-beta" },
    body: "{}",
  });

  assert.equal(capturedHeader, "existing-beta,fast-mode-2026-02-01");
});

test("standard Anthropic requests do not opt into Fast mode", async () => {
  let capturedHeader: string | null = null;
  const fetch = createAnthropicCompatFetch(
    async (_input, init) => {
      capturedHeader = new Headers(init?.headers).get("anthropic-beta");
      return new Response("ok");
    },
    { speed: "standard" },
  );

  await fetch("https://example.test/v1/messages", { method: "POST", body: "{}" });

  assert.equal(capturedHeader, null);
});
