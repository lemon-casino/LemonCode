import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { CopilotAuthDriver } from "./copilot.js";
import { GoogleAuthDriver } from "./google.js";
import { OpenAIAuthDriver } from "./openai.js";
import { codeAssistResponse, geminiRequest } from "./google-wire.js";
import { record, list, type Fetcher } from "./common.js";

function context(grant: AuthGrant): AuthDriverContext {
  return {
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
  };
}
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", body: JSON.stringify(body) });

test("Copilot exchanges account token, discovers actual protocols and activates a selected model policy", async () => {
  const calls: Request[] = [];
  const driver = new CopilotAuthDriver(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.endsWith("/token"))
      return Response.json({
        token: "session-fixture",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        endpoints: { api: "https://api.githubcopilot.com" },
      });
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "claude-fixture",
            name: "Claude Fixture",
            model_picker_enabled: true,
            supported_endpoints: ["/chat/completions", "/v1/messages"],
            policy: { state: "disabled", terms: "Enable" },
            capabilities: {
              type: "chat",
              supports: { vision: true },
              limits: { max_context_window_tokens: 1234 },
            },
          },
          { id: "blocked", policy: { state: "disabled" }, capabilities: { type: "chat" } },
        ],
      });
    if (request.url.endsWith("/policy")) return new Response(null, { status: 204 });
    return new Response('data: {"type":"message_stop"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const ctx = context({ type: "oauth", access: "github-fixture" });
  const models = await driver.models(ctx);
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "auto");
  const claude = models.find((model) => model.id === "claude-fixture");
  assert.equal(claude?.protocol, "anthropic-messages");
  assert.equal(claude?.contextWindow, 1234);
  const response = await driver.fetch(
    post("https://api.githubcopilot.com/v1/messages", {
      model: "claude-fixture",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
    ctx,
  );
  assert.match(await response.text(), /message_stop/);
  assert.equal(calls[0]?.headers.get("authorization"), "token github-fixture");
  assert.equal(calls[3]?.headers.get("authorization"), "Bearer session-fixture");
  assert.equal(calls[3]?.headers.get("anthropic-version"), "2023-06-01");
  assert.equal(calls.filter((call) => call.url.endsWith("/policy")).length, 1);
  await assert.rejects(
    driver.fetch(post("https://attacker.invalid/v1/messages", {}), ctx),
    /unsupported API endpoint/,
  );
  driver.dispose();
});

for (const channel of ["gemini", "antigravity"] as const)
  test(`${channel} refreshes Google token, provisions project, discovers account models and calls Code Assist`, async () => {
    const calls: Request[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith("/token"))
        return Response.json({ access_token: "google-fresh", expires_in: 3600 });
      if (request.url.includes(":loadCodeAssist"))
        return Response.json({
          cloudaicompanionProject: "project-fixture",
          currentTier: { id: "free-tier" },
        });
      if (request.url.includes(":fetchAvailableModels"))
        return Response.json({
          models: {
            "claude-fixture": { displayName: "Claude", maxTokens: 10000, supportsImages: true },
            tab_hidden: {},
          },
        });
      if (request.url.includes(":retrieveUserQuota"))
        return Response.json({ buckets: [{ modelId: "gemini-fixture", remainingFraction: 0.5 }] });
      return new Response(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const driver = new GoogleAuthDriver(channel, fetcher);
    const ctx = context({
      type: "oauth",
      access: "expired",
      refresh: "refresh-google",
      expires: 1,
    });
    const models = await driver.models(ctx);
    if (channel === "antigravity") assert.equal(models.length, 1);
    else assert.ok(models.some((model) => model.id === "gemini-3.5-flash"));
    const model = models[0]!;
    const response = await driver.fetch(
      post(model.baseURL + "/messages", {
        model: model.id,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 200,
        tools: [
          {
            name: "fixture",
            input_schema: {
              type: "object",
              properties: {
                values: { type: "object", propertyNames: { type: "string" } },
                count: { oneOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] },
              },
            },
          },
        ],
      }),
      ctx,
    );
    const result = record(await response.json());
    assert.equal(record(list(result.content)[0]).text, "Hello");
    assert.equal(record(result.usage).input_tokens, 4);
    const upstream = calls.at(-1)!;
    assert.equal(upstream.headers.get("authorization"), "Bearer google-fresh");
    assert.match(upstream.url, /v1internal:streamGenerateContent\?alt=sse$/);
    const payload = record(await upstream.json());
    const parameters = record(
      record(list(record(list(record(payload.request).tools)[0]).functionDeclarations)[0])
        .parameters,
    );
    assert.deepEqual(record(parameters.properties).values, { type: "object" });
    assert.deepEqual(record(parameters.properties).count, {
      type: "integer",
      minimum: 0,
      nullable: true,
    });
    assert.equal(payload.project, "project-fixture");
    assert.equal(
      payload.model,
      channel === "gemini" && model.id === "gemini-3.5-flash" ? "gemini-3-flash" : model.id,
    );
    assert.equal((await ctx.read())?.refresh, "refresh-google");
    driver.dispose();
  });

test("ChatGPT API refresh uses registered client and unwraps Responses completion", async () => {
  const calls: Request[] = [];
  const driver = new OpenAIAuthDriver("chatgpt-api", async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.endsWith("/token"))
      return Response.json({
        access_token: "api-fresh",
        refresh_token: "api-rotated",
        expires_in: 3600,
      });
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp-fixture","output":[],"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const ctx = context({
    type: "oauth",
    access: "old",
    refresh: "refresh",
    clientId: "registered-fixture",
    expires: 1,
  });
  const response = await driver.fetch(
    post("https://api.openai.com/v1/responses", { model: "gpt-fixture", input: "hello" }),
    ctx,
  );
  assert.equal(record(await response.json()).id, "resp-fixture");
  assert.equal(new URLSearchParams(await calls[0]!.text()).get("client_id"), "registered-fixture");
  assert.equal(calls[1]?.headers.get("chatgpt-account-id"), null);
  assert.equal((await ctx.read())?.refresh, "api-rotated");
  driver.dispose();
});

test("Gemini separates tool results/images from text and response cancellation rejects promptly", async () => {
  const payload = geminiRequest({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "view", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            ],
          },
          { type: "text", text: "explain" },
        ],
      },
    ],
  });
  assert.equal(list(payload.contents).length, 3);
  assert.match(JSON.stringify(payload), /skip_thought_signature_validator/);
  assert.match(JSON.stringify(payload), /inlineData/);
  const controller = new AbortController();
  const source = new ReadableStream<Uint8Array>({ start() {} });
  const response = codeAssistResponse(
    new Response(source, { headers: { "content-type": "text/event-stream" } }),
    "fixture",
    true,
    controller.signal,
  );
  const body = response.text();
  controller.abort();
  await assert.rejects(body, /abort/i);
});
