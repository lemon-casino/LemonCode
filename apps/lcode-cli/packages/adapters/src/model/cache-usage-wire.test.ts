import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";
import { parseProviderConfig, type RegistryProviderConfig } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";
import { normalizeUsage } from "./runner-normalization.js";
import type { ProjectId, SessionId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../storage/session-store.js";

type Protocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";
function response(protocol: Protocol, streaming: boolean, write: number | undefined, extra = {}) {
  const details = {
    cached_tokens: 40,
    ...(write === undefined ? {} : { cache_write_tokens: write }),
  };
  let result: Record<string, unknown>, frames: unknown[];
  if (protocol === "openai-chat-completions") {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: details,
      ...extra,
    };
    result = {
      id: "chat",
      model: "fixture",
      created: 1,
      choices: [
        { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
      ],
      usage,
    };
    frames = [
      { id: "chat", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] },
      { id: "chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chat", choices: [], usage },
      { id: "chat", choices: [], usage },
    ];
  } else if (protocol === "openai-responses") {
    result = {
      id: "resp_fixture",
      created_at: 1,
      model: "fixture",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_fixture",
          role: "assistant",
          content: [{ type: "output_text", text: "pong", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: details,
      },
    };
    frames = [
      { type: "response.created", response: { ...result, output: [], status: "in_progress" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_fixture", role: "assistant", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_fixture",
        output_index: 0,
        content_index: 0,
        delta: "pong",
      },
      { type: "response.completed", response: result },
    ];
  } else {
    result = {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text: "pong" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 60 - (write ?? 0),
        output_tokens: 5,
        cache_read_input_tokens: 40,
        ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
      },
    };
    frames = [
      { type: "message_start", message: { ...result, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ];
  }
  return streaming
    ? new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    : Response.json(result);
}

async function run(protocol: Protocol, streaming: boolean, write: number | undefined, extra = {}) {
  const execution = new AiSdkModelExecution(
    {},
    { transport: async () => response(protocol, streaming, write, extra) },
  );
  const model = execution
    .bindModel({
      providerId: "oauth:fixture",
      modelId: "fixture",
      providerConfig: parseProviderConfig({
        group: "standard-personal",
        api: { type: protocol, baseUrl: "https://fixture.invalid/v1" },
        access: { type: "oauth-account", channelId: "copilot" },
      }) as RegistryProviderConfig,
      supportsJsonSchemaOutput: false,
      optionSpecs: {
        reasoningLevel: { map: "{}" },
        maxOutputTokens: { map: "{}" },
      },
    })
    .resolveRequest({
      options: { reasoningLevel: "high", maxOutputTokens: 64 },
      requestAuth: { apiKey: "fixture-only" },
    }).model;
  const options = { model, prompt: "ping", maxRetries: 0 };
  if (!streaming) return normalizeUsage((await generateText(options)).totalUsage);
  const result = streamText(options);
  await result.consumeStream();
  return normalizeUsage(await result.totalUsage);
}

test("all model protocols settle their reported cache write in the same SQLite usage ledger", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = "cache-fixture" as SessionId;
  await store.createSession({
    id: sessionID,
    projectID: "fixture" as ProjectId,
    directory: "fixture",
    slug: "fixture",
    title: "fixture",
    version: "1",
  });
  const now = Date.now();
  try {
    for (const protocol of [
      "openai-chat-completions",
      "openai-responses",
      "anthropic-messages",
    ] as const)
      for (const streaming of [false, true]) {
        const usage = await run(protocol, streaming, 30);
        const id = `${protocol}:${streaming}`;
        await store.recordModelUsage({
          id,
          logicalRequestId: id,
          sessionID,
          providerId: "oauth:fixture",
          modelId: protocol,
          querySource: "main_turn",
          status: "completed",
          startedAt: now,
          usageKnown: true,
          rawUsage: usage,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadTokens,
          cacheCreationInputTokens: usage.cacheWriteTokens,
        });
      }
    const snapshot = await store.queryProviderUsage({
      range: "7d",
      since: now - 1000,
      until: now + 1000,
    });
    assert.equal(snapshot.summary.cacheWriteTokens, 180);
    assert.equal(snapshot.summary.cacheWriteKnownRequests, 6);
    assert.equal(snapshot.summary.totalTokens, 630);
  } finally {
    store.close();
  }
});

for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  for (const streaming of [false, true])
    for (const write of [30, 0, undefined])
      test(`${protocol} ${streaming ? "stream" : "generate"} preserves cache write ${write ?? "unknown"} without double counting`, async () => {
        const usage = await run(protocol, streaming, write);
        assert.equal(usage.cacheWriteTokens, write);
        assert.equal(usage.cacheWriteTokensReported, write !== undefined);
        assert.equal(usage.cacheReadTokens, 40);
        assert.equal(usage.inputTokens, 100);
        assert.equal(usage.totalTokens, 105);
      });

for (const streaming of [false, true]) {
  for (const extra of [
    { prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 30 } },
    { cache_creation_input_tokens: 30 },
    { prompt_tokens_details: {}, cache_read_input_tokens: 40, cache_creation_input_tokens: 30 },
    { prompt_tokens_details: {}, prompt_cache_hit_tokens: 40, cache_creation_input_tokens: 30 },
  ])
    test(`Chat ${streaming ? "stream" : "generate"} preserves vendor aliases ${JSON.stringify(extra)}`, async () => {
      const usage = await run("openai-chat-completions", streaming, undefined, extra);
      assert.equal(usage.cacheWriteTokens, 30);
      assert.equal(usage.cacheReadTokens, 40);
      assert.equal(usage.totalTokens, 105);
    });
  test(`Chat ${streaming ? "stream" : "generate"} preserves explicit zero precedence`, async () => {
    const usage = await run("openai-chat-completions", streaming, 0, {
      cache_creation_input_tokens: 30,
    });
    assert.equal(usage.cacheWriteTokens, 0);
  });
  for (const value of [-1, "30", null, 1.5])
    test(`Chat ${streaming ? "stream" : "generate"} does not invent write tokens from invalid ${value}`, async () => {
      const usage = await run("openai-chat-completions", streaming, undefined, {
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: value },
        prompt_cache_miss_tokens: 60,
      });
      assert.equal(usage.cacheWriteTokens, undefined);
      assert.equal(usage.totalTokens, 105);
    });
}
