import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  createServer as createH2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";
for (const status of [429, 503])
  test(
    "PC-05 Cursor actual H2 " + status + " cannot fall through to another model POST",
    { timeout: 10000 },
    async (t) => {
      let h2Posts = 0,
        h1Posts = 0;
      const sessions = new Set<ServerHttp2Session>();
      const h2 = createH2Server();
      h2.on("session", (session) => {
        sessions.add(session);
        session.once("close", () => sessions.delete(session));
      });
      h2.on("stream", (stream: ServerHttp2Stream, headers) => {
        if (headers[":method"] === "POST") h2Posts++;
        stream.on("error", () => {});
        stream.respond({
          ":status": status,
          "content-type": "application/json",
          "retry-after": "7",
        });
        stream.end(JSON.stringify({ error: { code: "resource_exhausted", message: "fixture" } }));
      });
      const h1 = createServer((req, res) => {
        req.resume();
        if (req.url!.endsWith("/AvailableModels")) {
          res.end(
            JSON.stringify({
              models: [
                {
                  name: "grok-4.7-fast",
                  clientDisplayName: "Fixture",
                  contextTokenLimit: 128000,
                  supportsNonMaxMode: true,
                },
              ],
            }),
          );
          return;
        }
        if (req.url!.endsWith("/GetUsableModels")) {
          res.end(JSON.stringify({ models: [{ modelId: "grok-4.7-fast" }] }));
          return;
        }
        if (req.url!.endsWith("/RunSSE") || req.url!.endsWith("/BidiAppend")) h1Posts++;
        res.writeHead(503).end();
      });
      await Promise.all([
        new Promise<void>((r) => h2.listen(0, "127.0.0.1", r)),
        new Promise<void>((r) => h1.listen(0, "127.0.0.1", r)),
      ]);
      const driver = createPluginAuthFixtureDriver(
        "cursor",
        "http://127.0.0.1:" + (h1.address() as AddressInfo).port,
        "http://127.0.0.1:" + (h2.address() as AddressInfo).port,
      )!;
      t.after(async () => {
        await driver.dispose?.();
        for (const session of sessions) session.destroy();
        h1.closeAllConnections();
        await Promise.all([
          new Promise<void>((r) => h2.close(() => r())),
          new Promise<void>((r) => h1.close(() => r())),
        ]);
      });
      const access =
        "e30." +
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString(
          "base64url",
        ) +
        ".fixture";
      const context = {
        routingSingleAttempt: true as const,
        read: async () => ({ type: "oauth" as const, access, refresh: "", expires: 0 }),
        write: async () => {},
      };
      const models = await driver.models(context),
        model = models[0]!;
      assert.ok(model);
      h1Posts = 0;
      const response = await driver.fetch(
        new Request(model.baseURL + "/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: "user", content: "fixture" }],
            stream: true,
          }),
        }),
        context,
      );
      await response.text();
      assert.equal(h2Posts, 1);
      assert.equal(h1Posts, 0);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("retry-after"), "7");
    },
  );
