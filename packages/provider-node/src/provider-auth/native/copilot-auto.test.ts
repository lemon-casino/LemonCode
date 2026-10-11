import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAutoRouter } from "./copilot-auto.js";
import { copilotCatalog } from "./copilot-models.js";
import type { AuthModel } from "../driver.js";
import { record, list } from "./common.js";
const options = () => ({
  base: "https://api.githubcopilot.com",
  headers: { authorization: "Bearer fixture" },
  signal: new AbortController().signal,
  models: [
    {
      id: "gpt-4.1",
      name: "Base",
      protocol: "openai-chat-completions",
      baseURL: "https://api.githubcopilot.com",
    },
  ] as AuthModel[],
});
const body = { model: "auto", stream: false, messages: [{ role: "user", content: "hello" }] };

test("Auto v2 allocates per account, reuses session and sends the selected chat model", async () => {
  const calls: Request[] = [];
  const router = new CopilotAutoRouter(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.endsWith("/auto"))
      return Response.json({
        session_token: "auto-token",
        selected_model: { id: "selected", supported_endpoints: ["/chat/completions"] },
        expires_at: Date.now() / 1000 + 3600,
      });
    return Response.json({ id: "ok", choices: [] });
  });
  await (
    await router.request(body, { ...options(), headers: { "x-github-api-version": "2026-07-01" } })
  ).text();
  await (await router.request(body, options())).text();
  assert.equal(calls.filter((r) => r.url.endsWith("/auto")).length, 1);
  assert.equal(calls[0]!.headers.get("x-github-api-version"), "2026-08-01");
  assert.deepEqual(await calls[0]!.json(), { prompt: "hello", tier: "balance" });
  assert.equal(calls[1]!.headers.get("copilot-session-token"), "auto-token");
  assert.equal(record(await calls[1]!.json()).model, "selected");
});

test("Auto legacy allocation and unsupported picks use a permitted manual model", async () => {
  const calls: Request[] = [];
  const router = new CopilotAutoRouter(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    if (request.url.endsWith("/auto")) return new Response(null, { status: 404 });
    if (request.url.endsWith("/models/session"))
      return Response.json({
        session_token: "legacy",
        available_models: ["gpt-4.1"],
        expires_at: Date.now() / 1000 + 3600,
      });
    return Response.json({ choices: [] });
  });
  await (await router.request(body, options())).text();
  assert.equal(calls[1]!.headers.get("x-github-api-version"), "2025-10-01");
  assert.equal(calls[2]!.headers.get("copilot-session-token"), "legacy");
  const refused: string[] = [];
  const retry = new CopilotAutoRouter(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/auto"))
      return Response.json({ session_token: "picked", selected_model: { id: "unavailable" } });
    const sent = record(await request.json());
    refused.push(String(sent.model));
    return sent.model === "unavailable"
      ? Response.json({ error: { code: "model_not_supported" } }, { status: 400 })
      : Response.json({ choices: [] });
  });
  await (await retry.request(body, options())).text();
  assert.deepEqual(refused, ["unavailable", "gpt-4.1"]);
  assert.equal(retry.isRefused("unavailable"), true);
});

test("Auto accepts a string selected model and retains its catalogue protocol", async () => {
  const paths: string[] = [];
  const router = new CopilotAutoRouter(async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/auto")
      return Response.json({ session_token: "selected", selected_model: "known-responses" });
    return Response.json({ id: "r", output: [] });
  });
  await router.request(body, {
    ...options(),
    seen: new Map([["known-responses", ["openai-responses"]]]),
  });
  assert.deepEqual(paths, ["/auto", "/responses"]);
});

test("Auto selected Responses model preserves tools, images, usage and chat streaming contract", async () => {
  let sent: Record<string, unknown> = {};
  const router = new CopilotAutoRouter(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/auto"))
      return Response.json({
        session_token: "auto",
        selected_model: { id: "responses-only", supported_endpoints: ["/responses"] },
      });
    assert.ok(request.url.endsWith("/responses"));
    sent = record(await request.json());
    const events = [
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "f1", call_id: "call1", name: "lookup", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":1}' },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 7, output_tokens: 2 },
          output: [{ type: "function_call" }],
        },
      },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const response = await router.request(
    {
      ...body,
      stream: true,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,Zg==" } },
            { type: "text", text: "Look" },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            { id: "prior", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "prior", content: "done" },
      ],
    },
    options(),
  );
  const stream = await response.text();
  assert.match(JSON.stringify(sent.input), /input_image/);
  assert.match(JSON.stringify(sent.input), /function_call_output/);
  assert.match(stream, /call1/);
  assert.match(stream, /tool_calls/);
  assert.match(stream, /prompt_tokens":7/);
  assert.match(stream, /\[DONE\]/);
});

test("Auto selected Anthropic model converts tool response and cached token counts", async () => {
  let sent: Record<string, unknown> = {};
  const router = new CopilotAutoRouter(async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/auto"))
      return Response.json({
        session_token: "auto",
        selected_model: { id: "claude", supported_endpoints: ["/v1/messages"] },
      });
    assert.ok(request.url.endsWith("/v1/messages"));
    sent = record(await request.json());
    return Response.json({
      id: "message",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "tool_use", id: "call", name: "lookup", input: { q: 1 } },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        output_tokens: 5,
      },
    });
  });
  const response = await router.request(
    {
      ...body,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
      ],
    },
    options(),
  );
  const result = record(await response.json());
  assert.deepEqual(sent.system, [{ type: "text", text: "system" }]);
  const choice = record(list(result.choices)[0]);
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(record(choice.message).reasoning_content, "reason");
  assert.equal(record(result.usage).prompt_tokens, 9);
});

test("Auto does not replay ordinary errors or errors arriving inside a successful stream", async () => {
  let attempts = 0;
  const router = new CopilotAutoRouter(async (input) =>
    String(input).endsWith("/auto")
      ? Response.json({ session_token: "auto", selected_model: { id: "picked" } })
      : (++attempts,
        new Response('data: {"error":{"code":"model_not_supported"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })),
  );
  const response = await router.request({ ...body, stream: true }, options());
  assert.match(await response.text(), /model_not_supported/);
  assert.equal(attempts, 1);
});

test("Copilot catalogue filters internal policies and ranks safe manual fallback", () => {
  const catalog = copilotCatalog(
    {
      data: [
        { id: "copilot-search", model_picker_enabled: true, capabilities: { type: "chat" } },
        { id: "hidden-snapshot", capabilities: { type: "chat" } },
        {
          id: "category-without-policy",
          model_picker_category: "versatile",
          capabilities: { type: "chat" },
        },
        { id: "unknown-capability", model_picker_enabled: true },
        {
          id: "experimental",
          vendor: "Experimental",
          model_picker_enabled: true,
          capabilities: { type: "chat" },
        },
        {
          id: "disabled",
          model_picker_enabled: true,
          policy: { state: "disabled" },
          capabilities: { type: "chat" },
        },
        {
          id: "terms",
          model_picker_enabled: true,
          policy: { state: "disabled", terms: "agree" },
          supported_endpoints: ["/responses"],
          capabilities: {
            type: "chat",
            supports: { reasoning_effort: ["low", "high"], vision: true, tool_calls: true },
          },
        },
        { id: "premium", model_picker_enabled: true, capabilities: { type: "chat" } },
        { id: "gpt-4.1", model_picker_enabled: true, capabilities: { type: "chat" } },
      ],
    },
    "https://api.githubcopilot.com",
  );
  assert.deepEqual(
    catalog.models.map((model) => model.id),
    ["auto", "terms", "premium", "gpt-4.1"],
  );
  assert.equal(catalog.manual[0]!.id, "gpt-4.1");
  assert.ok(catalog.policies.has("terms"));
  assert.deepEqual(catalog.models[1]!.reasoningEfforts, ["low", "high"]);
});
