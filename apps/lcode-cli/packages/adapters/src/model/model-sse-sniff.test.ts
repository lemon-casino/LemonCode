import assert from "node:assert/strict";
import test from "node:test";
import { sniffModelSseResponse } from "./model-sse-sniff.js";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGzip, createDeflate, createBrotliCompress, constants } from "node:zlib";
import { createProviderNetworkTransport } from "@lcode/provider-node/network";
import { createProviderBusinessErrorFetch } from "./model-execution.js";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, jsonSchema } from "ai";

for (const contentType of [undefined, "text/plain", "application/json"]) {
  test(`stream intent recognizes SSE with ${contentType ?? "missing"} header without awaiting EOF`, async () => {
    let cancelled = false;
    const bytes = new TextEncoder().encode('\uFEFF: heartbeat\r\ndata: {"text":"你好"}\r\n\r\n');
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await sniffModelSseResponse(
      new Response(body, { headers: contentType ? { "content-type": contentType } : {} }),
      true,
    );
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    assert.deepEqual((await reader.read()).value, bytes);
    await reader.cancel();
    assert.equal(cancelled, true);
  });
}

test("fragmented prefix and UTF-8 replay exactly once; JSON, HTML, NDJSON and oversized whitespace stay unchanged", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"你"}\n\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const response = await sniffModelSseResponse(new Response(body), true);
  assert.equal(await response.text(), 'data: {"text":"你"}\n\n');
  for (const text of [
    '{"error":{"code":429}}',
    "<html>error</html>",
    '{"text":"one"}\n{"text":"two"}',
    " ".repeat(5000) + "data: later",
    "plain text",
  ]) {
    const result = await sniffModelSseResponse(
      new Response(text, { headers: { "content-type": "application/json" } }),
      true,
    );
    assert.equal(result.headers.get("content-type"), "application/json");
    assert.equal(await result.text(), text);
  }
  const nonStream = new Response("data: text", { headers: { "content-type": "application/json" } });
  assert.equal(await sniffModelSseResponse(nonStream, false), nonStream);
});

test("cancelling during an incomplete prefix releases the underlying reader", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("da"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const waiting = sniffModelSseResponse(new Response(body), true, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(cancelled, true);
});

for (const encoding of ["gzip", "deflate", "br"] as const)
  test(
    `${encoding} SSE with a JSON header emits its first frame before EOF`,
    { timeout: 3000 },
    async (t) => {
      const server = createServer((request, response) => {
        request.resume();
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": encoding,
        });
        const compressor =
          encoding === "gzip"
            ? createGzip()
            : encoding === "deflate"
              ? createDeflate()
              : createBrotliCompress();
        compressor.on("error", () => {});
        response.on("close", () => compressor.destroy());
        compressor.pipe(response);
        compressor.write('data: {"text":"你好"}\r\n\r\n');
        compressor.flush(
          encoding === "br" ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH,
        );
      });
      const owner = createProviderNetworkTransport(async () => ({}));
      t.after(async () => {
        owner.dispose();
        server.closeAllConnections();
        server.close();
        await owner.disposeAndWait();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const wrapped = createProviderBusinessErrorFetch({
        providerId: "fixture",
        providerKind: "openai-compatible",
        fetch: owner.fetch,
      });
      const result = await wrapped(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body: '{"stream":true}',
      });
      assert.equal(result.headers.get("content-type"), "text/event-stream");
      assert.equal(result.headers.get("content-encoding"), null);
      const reader = result.body!.getReader();
      assert.equal(
        new TextDecoder().decode((await reader.read()).value),
        'data: {"text":"你好"}\r\n\r\n',
      );
      await reader.cancel();
    },
  );

for (const protocol of ["openai", "anthropic"] as const)
  test(`${protocol} SDK preserves UTF-8 and tool arguments through fragmented mislabeled SSE`, async () => {
    const frames =
      protocol === "openai"
        ? [
            {
              choices: [
                { index: 0, delta: { role: "assistant", content: "你好" }, finish_reason: null },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_fixture",
                        type: "function",
                        function: { name: "fixture_tool", arguments: '{"value":' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"测试"}' } }] },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: "fixture",
                type: "message",
                role: "assistant",
                model: "fixture",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "call_fixture",
                name: "fixture_tool",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"value":' },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '"测试"}' },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ];
    const bytes = new TextEncoder().encode(
      ": heartbeat\r\n\r\n" +
        frames
          .map(
            (frame) =>
              `${"type" in frame ? `event: ${frame.type}\r\n` : ""}data: ${JSON.stringify(frame)}\r\n\r\n`,
          )
          .join("") +
        (protocol === "openai" ? "data: [DONE]\r\n\r\n" : ""),
    );
    const wrapped = createProviderBusinessErrorFetch({
      providerId: "fixture",
      providerKind: protocol === "anthropic" ? "anthropic" : "openai-compatible",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const model =
      protocol === "anthropic"
        ? createAnthropic({ apiKey: "synthetic", fetch: wrapped })("fixture")
        : createOpenAICompatible({
            name: "fixture",
            apiKey: "synthetic",
            baseURL: "https://example.test",
            fetch: wrapped,
          })("fixture");
    const result = streamText({
      model,
      prompt: "fixture",
      maxRetries: 0,
      tools: {
        fixture_tool: {
          description: "fixture",
          inputSchema: jsonSchema<{ value: string }>({
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          }),
        },
      },
    });
    const events = [];
    for await (const event of result.fullStream) events.push(event);
    assert.equal(await result.text, "你好");
    assert.deepEqual(events.find((event) => event.type === "tool-call")?.input, { value: "测试" });
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
    );
  });
