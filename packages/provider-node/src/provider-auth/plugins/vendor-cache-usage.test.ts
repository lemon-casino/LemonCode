import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AuthGrant } from "../driver.js";
import { createPluginAuthFixtureDriver } from "../plugins.js";
import { record } from "../native/common.js";

for (const channel of ["qoder", "qoder-cn", "trae-cn", "trae-global"])
  for (const streaming of [false, true])
    for (const write of [30, 0, undefined])
      for (const raw of [false, true])
      test(`${channel} bundled transport ${streaming ? "stream" : "generate"} ${raw ? "raw" : "details"} preserves cache write ${write ?? "unknown"}`, async (t) => {
        const usage = {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          ...(raw ? { cache_read_input_tokens: 40, ...(write === undefined ? {} : { cache_creation_input_tokens: write }) } : { prompt_tokens_details: {
            cached_tokens: 40,
            ...(write === undefined ? {} : { cache_write_tokens: write }),
          } }),
        };
        const frames = [
          { id: "fixture", choices: [{ delta: { content: "pong" }, finish_reason: null }] },
          { id: "fixture", choices: [{ delta: {}, finish_reason: "stop" }] },
          { id: "fixture", choices: [], usage },
        ];
        const server = createServer(async (req, res) => {
          for await (const _ of req) {
            /* consume the synthetic request */
          }
          if (req.url?.includes("/algo/api/v2/model/list")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                chat: [{ key: "fixture-model", enable: true, max_input_tokens: 64000 }],
              }),
            );
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(429).end();
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (channel.startsWith("trae")) {
            res.end(
              `event: output\ndata: ${JSON.stringify({ response: "pong" })}\n\n` +
                `event: token_usage\ndata: ${JSON.stringify({ usage })}\n\n` +
                `event: done\ndata: ${JSON.stringify({ finish_reason: "stop" })}\n\n`,
            );
            return;
          }
          res.end(
            frames
              .map(
                (frame) =>
                  `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify(frame) })}\n\n`,
              )
              .join("") + `data: ${JSON.stringify({ statusCodeValue: 200, body: "[DONE]" })}\n\n`,
          );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const driver = createPluginAuthFixtureDriver(
          channel,
          `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        )!;
        t.after(async () => {
          await driver.dispose?.();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        });
        let grant: AuthGrant = {
          type: "oauth",
          access: "fixture-access",
          refresh: "fixture-refresh",
          uid: "fixture-user",
          machineId: "fixture-machine",
          expires: Date.now() + 3_600_000,
        };
        const context = {
          read: async () => grant,
          write: async (next: AuthGrant) => {
            grant = next;
          },
        };
        const models = await driver.models(context);
        const model = channel.startsWith("qoder")
          ? models.find((model) => model.id === "fixture-model")!
          : models[0]!;
        const output = await driver.fetch(
          new Request(model.baseURL.replace(/\/$/, "") + "/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: model.id,
              messages: [{ role: "user", content: "ping" }],
              stream: streaming,
            }),
          }),
          context,
        );
        assert.equal(output.status, 200, output.ok ? "" : await output.text());
        const data = streaming
          ? (await output.text())
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
              .findLast((chunk) => chunk.usage)?.usage
          : record(await output.json()).usage;
        if (raw) {
          assert.equal(data.cache_creation_input_tokens, write);
          assert.equal(data.cache_read_input_tokens, 40);
        } else {
          assert.equal(data.prompt_tokens_details.cache_write_tokens, write);
          assert.equal(data.prompt_tokens_details.cached_tokens, 40);
        }
        assert.equal(data.total_tokens, 105);
      });
