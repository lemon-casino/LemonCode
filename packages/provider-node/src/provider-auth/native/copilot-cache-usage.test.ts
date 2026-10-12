import assert from "node:assert/strict";
import test from "node:test";
import { autoResponse } from "./copilot-auto-response.js";
import { record } from "./common.js";

for (const protocol of ["anthropic-messages", "openai-responses"] as const)
  for (const streaming of [false, true])
    for (const write of [30, 0, undefined])
      test(`Copilot Auto ${protocol} ${streaming ? "stream" : "generate"} preserves write ${write ?? "unknown"}`, async () => {
        const anthropic = protocol === "anthropic-messages";
        const usage = anthropic
          ? {
              input_tokens: 60 - (write ?? 0),
              output_tokens: 5,
              cache_read_input_tokens: 40,
              ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
            }
          : {
              input_tokens: 100,
              output_tokens: 5,
              input_tokens_details: {
                cached_tokens: 40,
                ...(write === undefined ? {} : { cache_write_tokens: write }),
              },
            };
        const result = {
          id: "fixture",
          model: "fixture",
          content: [],
          output: [],
          usage,
          status: "completed",
        };
        const frames = anthropic
          ? [
              { type: "message_start", message: result },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 5 },
              },
            ]
          : [{ type: "response.completed", response: result }];
        const input = streaming
          ? new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            })
          : Response.json(result);
        const output = await autoResponse(
          input,
          "fixture",
          protocol,
          streaming,
          new AbortController().signal,
        );
        const data = streaming
          ? (await output.text())
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
              .findLast((chunk) => chunk.usage)?.usage
          : record(await output.json()).usage;
        assert.equal(data.prompt_tokens, 100);
        assert.equal(data.total_tokens, 105);
        assert.equal(data.prompt_tokens_details.cached_tokens, 40);
        assert.equal(data.prompt_tokens_details.cache_write_tokens, write);
      });
