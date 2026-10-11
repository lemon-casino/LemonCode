import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAutoRouter } from "./copilot-auto.js";
import { CopilotAuthDriver } from "./copilot.js";
import { autoResponse } from "./copilot-auto-response.js";
import { autoRequest } from "./copilot-auto-request.js";
import { record, list } from "./common.js";
import type { AuthDriverContext, AuthGrant, AuthModel } from "../driver.js";
const base = "https://api.githubcopilot.com";
const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };
const options = (signal = new AbortController().signal) => ({
  base,
  headers: {},
  signal,
  models: [
    { id: "gpt-4.1", name: "Base", protocol: "openai-chat-completions", baseURL: base },
  ] as AuthModel[],
});
const selection = (id: string, endpoints = ["/chat/completions"]) =>
  Response.json({
    session_token: "session",
    selected_model: { id, supported_endpoints: endpoints },
  });

test("Auto cancellation leaves concurrent and later account requests usable", async () => {
  const cancelled = new AbortController();
  let first = true;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const router = new CopilotAutoRouter(async (input, init) => {
    if (String(input).endsWith("/auto")) {
      if (!first) return selection("working");
      first = false;
      started();
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
    }
    return Response.json({ choices: [] });
  });
  const abandoned = router.request(body, options(cancelled.signal));
  await ready;
  const unaffected = router.request(body, options());
  cancelled.abort();
  await assert.rejects(abandoned);
  assert.equal((await unaffected).status, 200);
  assert.equal((await router.request(body, options())).status, 200);
});

test("Auto clears stale sessions without excluding the model and never retries rate limits", async () => {
  let allocations = 0;
  let calls = 0;
  const router = new CopilotAutoRouter(async (input) => {
    if (String(input).endsWith("/auto")) {
      allocations++;
      return selection("same");
    }
    if (++calls === 1)
      return Response.json(
        { error: { message: "Requested model not available for session" } },
        { status: 400 },
      );
    return new Response(null, { status: 429 });
  });
  assert.equal((await router.request(body, options())).status, 429);
  assert.equal(allocations, 2);
  assert.equal(calls, 2);
  assert.equal(router.isRefused("same"), false);
  const failed = new CopilotAutoRouter(
    async (input) => new Response(null, { status: String(input).endsWith("/auto") ? 404 : 500 }),
  );
  await assert.rejects(failed.request(body, options()), /allocation failed/);
});

test("Auto retries selected Responses model as chat with no stale allocation token", async () => {
  const sent: Request[] = [];
  const router = new CopilotAutoRouter(async (input, init) => {
    if (String(input).endsWith("/auto")) return selection("refused", ["/responses"]);
    const request = new Request(input, init);
    sent.push(request);
    return request.url.endsWith("/responses")
      ? Response.json({ error: { code: "model_not_supported" } }, { status: 400 })
      : Response.json({ choices: [] });
  });
  await router.request(body, options());
  assert.equal(sent.length, 2);
  assert.ok(sent[0]!.url.endsWith("/responses"));
  assert.ok(sent[1]!.url.endsWith("/chat/completions"));
  assert.equal(sent[1]!.headers.get("copilot-session-token"), null);
  assert.equal(record(await sent[1]!.json()).model, "gpt-4.1");
  assert.equal(new CopilotAutoRouter().isRefused("refused"), false);
});

test("Auto message stream preserves tool deltas, usage and abort releases upstream", async () => {
  const events = [
    {
      type: "message_start",
      message: { id: "m", usage: { input_tokens: 5, cache_read_input_tokens: 2 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-id", name: "run", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"x":1}' },
    },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  const response = await autoResponse(
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")),
    "claude",
    "anthropic-messages",
    true,
    new AbortController().signal,
  );
  const output = await response.text();
  assert.match(output, /tool-id/);
  assert.match(output, /prompt_tokens":7/);
  assert.match(output, /completion_tokens":4/);
  assert.match(output, /finish_reason":"tool_calls/);
  let released = false;
  const abort = new AbortController();
  const waiting = await autoResponse(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          released = true;
        },
      }),
    ),
    "claude",
    "anthropic-messages",
    true,
    abort.signal,
  );
  const pending = waiting.text();
  abort.abort();
  await assert.rejects(pending);
  assert.equal(released, true);
});

test("Auto Responses JSON preserves reasoning and strict schema; message tool history is valid", async () => {
  const request = autoRequest(
    {
      ...body,
      response_format: {
        type: "json_schema",
        json_schema: { name: "out", strict: true, schema: { type: "object" } },
      },
    },
    "gpt",
    "openai-responses",
  );
  assert.equal(record(record(request.body.text).format).name, "out");
  const response = await autoResponse(
    Response.json({
      id: "r",
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
        { type: "reasoning", summary: [{ text: "reason" }] },
      ],
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    }),
    "gpt",
    "openai-responses",
    false,
    new AbortController().signal,
  );
  const result = record(await response.json());
  assert.equal(record(record(list(result.choices)[0]).message).reasoning_content, "reason");
  assert.equal(record(record(result.usage).completion_tokens_details).reasoning_tokens, 2);
  const history = autoRequest(
    {
      ...body,
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "t", function: { name: "run", arguments: '{"x":1}' } }],
        },
        { role: "tool", tool_call_id: "t", content: "done" },
      ],
    },
    "claude",
    "anthropic-messages",
  );
  assert.equal(record(list(record(list(history.body.messages)[0]).content)[0]).type, "tool_use");
  assert.equal(record(list(record(list(history.body.messages)[1]).content)[0]).tool_use_id, "t");
});

test("Copilot driver routes Auto, accepts selected policy and excludes manual refusals", async () => {
  const calls: Request[] = [];
  const driver = new CopilotAuthDriver(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "terms",
            model_picker_enabled: true,
            policy: { state: "disabled", terms: "agree" },
            supported_endpoints: ["/responses"],
            capabilities: { type: "chat" },
          },
          { id: "manual", model_picker_enabled: true, capabilities: { type: "chat" } },
        ],
      });
    if (request.url.endsWith("/auto")) return selection("terms", ["/responses"]);
    if (request.url.endsWith("/policy")) return new Response(null, { status: 204 });
    if (request.url.endsWith("/responses"))
      return Response.json({
        id: "r",
        output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
      });
    return Response.json({ error: { code: "model_not_supported" } }, { status: 400 });
  });
  let grant: AuthGrant = {
    type: "oauth",
    access: "fixture",
    sessionToken: "session",
    sessionExpires: Date.now() + 3600_000,
    apiBase: base,
  };
  const context: AuthDriverContext = {
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
  };
  const response = await driver.fetch(
    new Request(base + "/chat/completions", { method: "POST", body: JSON.stringify(body) }),
    context,
  );
  assert.match(await response.text(), /answer/);
  assert.equal(calls.filter((r) => r.url.endsWith("/policy")).length, 1);
  assert.equal(calls.at(-1)?.headers.get("copilot-session-token"), "session");
  await driver.fetch(
    new Request(base + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...body, model: "manual" }),
    }),
    context,
  );
  assert.equal(
    (await driver.models(context)).some((model) => model.id === "manual"),
    false,
  );
  driver.dispose();
});
