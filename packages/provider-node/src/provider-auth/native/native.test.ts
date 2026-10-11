import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { createNativeAuthDriver } from "../native.js";
import { OpenAIAuthDriver, prepareResponses } from "./openai.js";
import { codeAssistRequest, codeAssistResponse } from "./google-wire.js";
import { browserChallenge } from "./browser.js";

function context(grant: AuthGrant): AuthDriverContext {
  return {
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
  };
}

test("native factory recognizes the six channels only", async () => {
  for (const id of ["codex", "chatgpt-api", "copilot", "gemini", "antigravity", "claude"]) {
    const driver = await createNativeAuthDriver(id);
    assert.ok(driver);
    assert.ok((await driver.methods()).length > 0);
    await driver.dispose?.();
  }
  assert.equal(await createNativeAuthDriver("unknown"), null);
});

test("Responses preserves external tools and reasoning while removing refused fields", () => {
  const body = prepareResponses(
    {
      model: "gpt-test",
      instructions: "Follow the user",
      input: [{ role: "system", content: "sys" }],
      tools: [{ type: "function", name: "read_file" }],
      reasoning: { effort: "high" },
      max_output_tokens: 20,
    },
    "codex",
  );
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, undefined);
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file" }]);
  assert.equal((body.input as Array<Record<string, unknown>>)[0]?.role, "developer");
});

test("OpenAI refresh rotates grant and streams tool/usage frames without translation", async () => {
  const calls: Request[] = [];
  const wire =
    'event: response.function_call_arguments.delta\ndata: {"delta":"{}"}\n\nevent: response.completed\ndata: {"usage":{"input_tokens":7}}\n\n';
  const driver = new OpenAIAuthDriver("codex", async (input, init) => {
    const req = new Request(input, init);
    calls.push(req);
    if (req.url.endsWith("/oauth/token"))
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    return new Response(wire, { headers: { "content-type": "text/event-stream" } });
  });
  const ctx = context({
    type: "oauth",
    access: "expired",
    refresh: "refresh",
    expires: 1,
    accountId: "workspace-a",
  });
  const res = await driver.fetch(
    new Request("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
    }),
    ctx,
  );
  assert.equal(await res.text(), wire);
  assert.equal((await ctx.read())?.refresh, "new-refresh");
  assert.equal(calls[1]?.headers.get("chatgpt-account-id"), "workspace-a");
  await assert.rejects(
    driver.fetch(
      new Request("https://attacker.invalid/responses", { method: "POST", body: "{}" }),
      ctx,
    ),
    /endpoint/,
  );
});

test("OAuth callback checks state and cancellation releases listener", async () => {
  const ac = new AbortController();
  const challenge = await browserChallenge({
    authorizeURL: "https://accounts.example/authorize",
    parameters: {},
    signal: ac.signal,
    exchange: async () => ({ type: "oauth", access: "fixture" }),
  });
  const auth = new URL(challenge.url!);
  const redirect = new URL(auth.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", "fixture-code");
  redirect.searchParams.set("state", "wrong-state");
  const bad = await fetch(redirect);
  assert.equal(bad.status, 400);
  redirect.searchParams.set("state", auth.searchParams.get("state")!);
  const pending = challenge.complete(redirect.href);
  assert.equal((await pending).access, "fixture");
  const second = await browserChallenge({
    authorizeURL: "https://accounts.example/authorize",
    parameters: {},
    signal: ac.signal,
    exchange: async () => ({ type: "oauth" }),
  });
  const done = second.complete();
  ac.abort();
  await assert.rejects(done, /abort|cancel/i);
});

test("CodeAssist retains image, tool use/result and thinking signature", () => {
  const body = codeAssistRequest(
    {
      model: "gemini-test",
      max_tokens: 100,
      system: "help",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reason", signature: "signed" },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "contents" }],
        },
      ],
    },
    "antigravity",
    "project-a",
  );
  const raw = JSON.stringify(body);
  assert.match(raw, /inlineData/);
  assert.match(raw, /functionCall/);
  assert.match(raw, /functionResponse/);
  assert.match(raw, /signed/);
});

test("CodeAssist stream converts text/tools/usage and does not swallow errors", async () => {
  const upstream = new Response(
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hi"},{"functionCall":{"name":"read_file","args":{"path":"a"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3,"cachedContentTokenCount":2}}}\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
  const response = codeAssistResponse(upstream, "gemini-test", true);
  const text = await response.text();
  assert.match(text, /content_block_start/);
  assert.match(text, /tool_use/);
  assert.match(text, /read_file/);
  assert.match(text, /cache_read_input_tokens/);
  assert.match(text, /message_stop/);
  const denied = new Response("denied", { status: 429 });
  assert.equal(codeAssistResponse(denied, "gemini-test", true), denied);
});
