import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";
for (const channel of [
  "workbuddy",
  "workbuddy-ai",
  "qoder",
  "qoder-cn",
  "trae-cn",
  "trae-global",
  "cline",
  "minimax-code",
  "minimax-code-global",
  "zed",
])
  test(
    "PC-05 " + channel + " certified routing keeps exactly one physical model POST",
    { timeout: 15000 },
    async (t) => {
      let posts = 0;
      const paths: string[] = [];
      const server = createServer((req, res) => {
        req.resume();
        paths.push(req.url!);
        if (req.url!.includes("/algo/api/v2/model/list")) {
          res.end(
            JSON.stringify({
              chat: [{ key: "fixture-model", enable: true, max_input_tokens: 64000 }],
            }),
          );
          return;
        }
        if (req.url === "/models") {
          res.end(
            JSON.stringify({
              models: [{ id: "fixture-model", provider: "anthropic", max_token_count: 64000 }],
            }),
          );
          return;
        }
        if (req.url === "/client/llm_tokens") {
          res.end(JSON.stringify({ token: "fixture-model-token" }));
          return;
        }
        if (req.method === "POST") posts++;
        res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
        res.end(JSON.stringify({ error: { message: "fixture limit", code: "rate_limit" } }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const driver = createPluginAuthFixtureDriver(
        channel,
        "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      )!;
      t.after(async () => {
        await driver.dispose?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      assert.equal(driver.routingSingleAttempt, true);
      const grant = {
        type: "oauth" as const,
        access: "fixture-access",
        refresh: channel === "zed" ? JSON.stringify({ userId: "fixture-user" }) : "fixture-refresh",
        uid: "fixture-user",
        machineId: "fixture-machine",
        expires: Date.now() + 3600000,
      };
      const context = {
        routingSingleAttempt: true as const,
        read: async () => grant,
        write: async () => {},
      };
      const models = await driver.models(context);
      assert.ok(models.length);
      const model = models[0]!;
      posts = 0;
      paths.length = 0;
      const suffix =
        model.protocol === "anthropic-messages"
          ? "/messages"
          : model.protocol === "openai-responses"
            ? "/responses"
            : "/chat/completions";
      const request = new Request(model.baseURL.replace(/\/$/, "") + suffix, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "fixture" }],
          input: "fixture",
          stream: true,
          max_tokens: 16,
        }),
      });
      let response: Response | undefined;
      try {
        response = await driver.fetch(request, context);
      } catch (error) {
        assert.match(String(error), /429|limit/);
      }
      if (response) {
        assert.equal(response.status, 429);
        await response.text();
      }
      assert.equal(posts, 1, JSON.stringify(paths));
    },
  );
