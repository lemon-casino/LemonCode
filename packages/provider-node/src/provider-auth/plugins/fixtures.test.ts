import assert from "node:assert/strict";
import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import {
  createServer as createHttp2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { AuthDriver, AuthDriverContext, AuthGrant } from "../driver.js";
import { createPluginAuthFixtureDriver } from "../plugins.js";

interface Call {
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  text?: string;
  json?: unknown;
}
async function fixture(route: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const call = { path: req.url!, body: Buffer.concat(chunks).toString(), headers: req.headers };
      calls.push(call);
      const out = await route(call);
      res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
      res.end(out.text ?? JSON.stringify(out.json ?? {}));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const drivers: AuthDriver[] = [];
  return {
    calls,
    driver(channel: string, h2Origin?: string) {
      const driver = createPluginAuthFixtureDriver(
        channel,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        h2Origin,
      );
      assert.ok(driver);
      drivers.push(driver);
      return driver;
    },
    async close() {
      await Promise.all(drivers.map((driver) => driver.dispose?.()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
function account(initial: AuthGrant) {
  let grant = initial;
  const writes: AuthGrant[] = [];
  const context: AuthDriverContext = {
    read: async () => grant,
    write: async (next) => {
      writes.push(next);
      grant = next;
    },
  };
  return { context, writes, read: () => grant };
}
function request(url: string, body: unknown, signal?: AbortSignal) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-lcode-session-id": "fixture-conversation" },
    body: JSON.stringify(body),
    signal,
  });
}
const json = (data: unknown): Reply => ({ json: data });
const envelope = (data: unknown): Reply => json({ code: 0, data });
const unavailable: Reply = { status: 503, json: { error: "fixture endpoint unavailable" } };

test("all 15 packages, regional variants and zcode alias expose actual login methods", async (t) => {
  const f = await fixture(() => unavailable);
  t.after(() => f.close());
  for (const channel of [
    "bigmodel",
    "zai",
    "zcode",
    "cline",
    "commandcode-plan",
    "cursor",
    "devin",
    "factory",
    "grok",
    "kiro",
    "minimax-code",
    "minimax-code-global",
    "mimo-app",
    "qoder",
    "qoder-cn",
    "trae-cn",
    "trae-global",
    "workbuddy",
    "workbuddy-ai",
    "zed",
    "opencode-zen-free",
  ]) {
    const driver = f.driver(channel);
    const methods = await driver.methods();
    assert.ok(methods.length, channel);
    assert.ok(
      methods.every((method) => method.label && ["oauth", "api"].includes(method.type)),
      channel,
    );
    if (["bigmodel", "zai", "zcode"].includes(channel)) {
      assert.equal(methods[0]!.id, channel === "bigmodel" ? "1" : "0");
      assert.ok(methods.every((method) => !method.fields?.some((field) => field.key === "site")));
    }
    await driver.dispose?.();
  }
  assert.equal(
    f.calls.length,
    0,
    "listing methods must not start login, import credentials, or contact upstream",
  );
});

test("plugin without a quota hook reports unsupported without calling inference", async (t) => {
  const f = await fixture(() => unavailable);
  t.after(() => f.close());
  const driver = f.driver("opencode-zen-free");
  const a = account({ type: "api", key: "public" });
  assert.deepEqual(await driver.quota!(a.context), { status: "unsupported" });
  assert.equal(f.calls.length, 0);
});

test("Cline device callback, refresh, models, quota, session headers and tool usage stream", async (t) => {
  const stream = [
    {
      id: "chat-1",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tool-1",
                type: "function",
                function: { name: "weather", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chat-1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    },
  ];
  const f = await fixture((c) => {
    if (c.path.endsWith("/authorize/device"))
      return json({
        device_code: "fixture-device",
        verification_uri: "https://example.test/activate",
        user_code: "ABCD",
        interval: 1,
        expires_in: 60,
      });
    if (c.path.endsWith("/authenticate"))
      return json({ access_token: "workos-fixture", refresh_token: "workos-refresh" });
    if (c.path.endsWith("/auth/register"))
      return json({
        accessToken: "cline-old",
        refreshToken: "cline-refresh",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userInfo: { clineUserId: "fixture-user" },
      });
    if (c.path.endsWith("/auth/refresh"))
      return json({
        accessToken: "cline-new",
        refreshToken: "cline-rotated",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (c.path.endsWith("/users/me/plan/usage-limits"))
      return json({ limits: [{ type: "five_hour", percentUsed: 25 }] });
    if (c.path.endsWith("/users/me"))
      return json({ clineUserId: "fixture-user", plan: "ClinePass" });
    if (c.path.endsWith("/balance")) return json({ balance: 7 });
    if (c.path.endsWith("/chat/completions"))
      return {
        headers: { "content-type": "text/event-stream" },
        text:
          stream.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      };
    return unavailable;
  });
  t.after(() => f.close());
  const driver = f.driver("cline");
  const challenge = await driver.authorize("0", {}, new AbortController().signal);
  assert.match(challenge.instructions!, /ABCD/);
  const grant = await challenge.complete();
  assert.equal(grant.type, "oauth");
  const a = account(grant);
  const models = await driver.models(a.context);
  assert.ok(models.length > 5);
  assert.equal(a.read().refresh, "cline-rotated");
  assert.equal(a.writes.length, 1);
  const response = await driver.fetch(
    request(models[0]!.baseURL + "/chat/completions", {
      model: models[0]!.id,
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
    a.context,
  );
  const text = await response.text();
  assert.match(text, /tool_calls/);
  assert.match(text, /prompt_tokens/);
  const upstream = f.calls.find((c) => c.path.endsWith("/chat/completions"))!;
  assert.equal(upstream.headers.authorization, "Bearer workos:cline-new");
  assert.equal(upstream.headers["x-lcode-session-id"], undefined);
  assert.ok(upstream.headers["x-task-id"]);
  const quota = (await driver.quota!(a.context)) as { windows: { used: number }[] };
  assert.equal(quota.windows[0]!.used, 25);
  await assert.rejects(
    driver.fetch(
      request("https://unrelated.test/chat/completions", { model: models[0]!.id }),
      a.context,
    ),
    /outside this provider/,
  );
});

test("BigModel and Z.AI perform independent init/poll, business token and personal key resolution", async (t) => {
  const f = await fixture((c) => {
    if (c.path.endsWith("/oauth/cli/init")) {
      const site = JSON.parse(c.body).provider;
      return envelope({
        flow_id: site,
        authorize_url: `https://${site}.example.test/login`,
        poll_interval_sec: 1,
      });
    }
    if (c.path.includes("/oauth/cli/poll/"))
      return envelope({
        status: "ready",
        bigmodel: { access_token: "bigmodel-business" },
        zai: { access_token: "zai-business" },
        user: { email: "fixture@example.test" },
      });
    if (c.path.endsWith("/api/auth/z/login")) return envelope({ access_token: "zai-normalized" });
    if (c.path.endsWith("/getCustomerInfo"))
      return envelope({
        organizations: [
          {
            organizationId: "org-fixture",
            projects: [{ projectId: "project-fixture", projectType: 1 }],
          },
        ],
      });
    if (c.path.endsWith("/api_keys"))
      return envelope([{ name: "zcode-api-key", apiKey: "fixture-id" }]);
    if (c.path.includes("/api_keys/copy/")) return envelope({ secretKey: "fixture-secret" });
    if (c.path.endsWith("/subscription/list"))
      return envelope([{ status: "VALID", productName: "GLM Coding Plan" }]);
    return unavailable;
  });
  t.after(() => f.close());
  for (const site of ["bigmodel", "zai"]) {
    const driver = f.driver(site);
    const challenge = await driver.authorize(
      site === "bigmodel" ? "1" : "0",
      {},
      new AbortController().signal,
    );
    const url = new URL(challenge.url!);
    assert.ok(url.searchParams.has(site === "bigmodel" ? "redirect" : "redirect_uri"));
    const grant = await challenge.complete();
    assert.equal(grant.access, "fixture-id.fixture-secret");
    assert.equal(JSON.parse(grant.refresh!).site, site);
    const models = await driver.models(account(grant).context);
    assert.ok(models.length);
    assert.match(models[0]!.baseURL, site === "bigmodel" ? /bigmodel.cn/ : /z.ai/);
    const response = await driver.fetch(
      request(models[0]!.baseURL + "/messages", {
        model: models[0]!.id,
        messages: [{ role: "user", content: "fixture hello" }],
        max_tokens: 64,
      }),
      account(grant).context,
    );
    assert.equal(response.status, 503);
    await response.text();
    const sent = f.calls.filter((call) => call.path.endsWith("/messages")).at(-1)!;
    assert.equal(sent.headers["x-api-key"], "fixture-id.fixture-secret");
    assert.match(
      String(sent.headers["x-fixture-upstream"]),
      site === "bigmodel" ? /bigmodel.cn/ : /z.ai/,
    );
    await assert.rejects(
      driver.models(
        account({
          ...grant,
          refresh: JSON.stringify({
            ...JSON.parse(grant.refresh!),
            site: site === "bigmodel" ? "zai" : "bigmodel",
          }),
        }).context,
      ),
      /matching channel/,
    );
  }
  const queries = f.calls.filter((c) => c.path.endsWith("/getCustomerInfo"));
  assert.notEqual(queries[0]!.headers.authorization, queries[1]!.headers.authorization);
});

test("Zed RSA browser callback and cold-worker Gemini tools/images/usage bridge invoke real vendor fetch", async (t) => {
  const f = await fixture((c) => {
    if (c.path === "/client/users/me")
      return json({ user: { github_login: "fixture-user" }, plan: { name: "zed_pro" } });
    if (c.path === "/client/llm_tokens") return json({ token: "fixture-model-token" });
    if (c.path === "/models")
      return json({
        models: [
          {
            id: "gemini-fixture",
            provider: "google",
            max_token_count: 100_000,
            max_output_tokens: 10_000,
            supports_images: true,
          },
        ],
      });
    if (c.path === "/completions")
      return {
        headers: { "content-type": "application/x-ndjson" },
        text:
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { text: "hello" },
                    { functionCall: { name: "weather", args: { city: "Paris" } } },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
          }) + "\n",
      };
    return unavailable;
  });
  t.after(() => f.close());
  const driver = f.driver("zed");
  const challenge = await driver.authorize("0", {}, new AbortController().signal);
  const url = new URL(challenge.url!);
  const key = createPublicKey({
    key: Buffer.from(url.searchParams.get("native_app_public_key")!, "base64url"),
    format: "der",
    type: "pkcs1",
  });
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from("fixture-access"),
  ).toString("base64url");
  const completing = challenge.complete();
  const callback = await fetch(
    `http://127.0.0.1:${url.searchParams.get("native_app_port")}/?user_id=fixture-id&access_token=${encrypted}`,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 302);
  const grant = await completing;
  assert.equal(grant.access, "fixture-access");
  const a = account(grant);
  const models = await driver.models(a.context);
  assert.equal(models[0]!.protocol, "anthropic-messages");
  assert.equal(models[0]!.images, true);
  const cold = f.driver("zed");
  const before = f.calls.filter((call) => call.path === "/models").length;
  const response = await cold.fetch(
    request(models[0]!.baseURL + "/messages", {
      model: "gemini-fixture",
      max_tokens: 100,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "weather",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string", propertyNames: { type: "string" } },
              count: { anyOf: [{ type: "integer", exclusiveMinimum: 0 }, { type: "null" }] },
            },
          },
        },
      ],
    }),
    a.context,
  );
  const text = await response.text();
  assert.match(text, /tool_use/);
  assert.match(text, /"input_tokens":7/);
  assert.match(text, /"output_tokens":4/);
  assert.equal(f.calls.filter((call) => call.path === "/models").length, before + 1);
  const sent = JSON.parse(f.calls.find((c) => c.path === "/completions")!.body);
  assert.equal(sent.provider, "google");
  assert.ok(sent.provider_request.contents[0].parts[1].inlineData);
  assert.equal(sent.provider_request.tools[0].functionDeclarations[0].name, "weather");
  assert.deepEqual(
    sent.provider_request.tools[0].functionDeclarations[0].parameters.properties.city,
    { type: "string" },
  );
  assert.deepEqual(
    sent.provider_request.tools[0].functionDeclarations[0].parameters.properties.count,
    { type: "integer", minimum: 0, nullable: true },
  );
});

test("cancelling Zed authorization closes its callback listener and rejects late completion", async (t) => {
  const f = await fixture(() => unavailable);
  t.after(() => f.close());
  const driver = f.driver("zed");
  const controller = new AbortController();
  const challenge = await driver.authorize("0", {}, controller.signal);
  const port = new URL(challenge.url!).searchParams.get("native_app_port");
  const completing = challenge.complete();
  controller.abort();
  await assert.rejects(completing, /cancel|disposed/i);
  await driver.dispose?.();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  assert.equal(f.calls.length, 0);
});

test("API auth executes Factory's model-specific Messages wire and preserves upstream failures", async (t) => {
  const f = await fixture((c) =>
    c.path.endsWith("/messages")
      ? {
          status: 429,
          json: {
            type: "error",
            error: { type: "rate_limit_error", message: "fixture quota exhausted" },
          },
        }
      : unavailable,
  );
  t.after(() => f.close());
  const driver = f.driver("factory");
  const challenge = await driver.authorize(
    "1",
    { key: "fk-fixture" },
    new AbortController().signal,
  );
  const grant = await challenge.complete();
  assert.equal(grant.type, "api");
  const a = account(grant);
  const models = await driver.models(a.context);
  const anthropic = models.find((model) => model.protocol === "anthropic-messages")!;
  assert.ok(anthropic);
  const response = await driver.fetch(
    request(anthropic.baseURL + "/messages", {
      model: anthropic.id,
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    }),
    a.context,
  );
  assert.equal(response.status, 429);
  assert.match(await response.text(), /quota exhausted/);
  const sent = f.calls.find((c) => c.path.endsWith("/messages"))!;
  assert.equal(sent.headers.authorization, "Bearer fk-fixture");
  assert.equal(JSON.parse(sent.body).messages.at(-1).content, "hello");
});

test("two plugin workers keep refresh rotations and credentials account-local", async (t) => {
  const f = await fixture((c) =>
    c.path.endsWith("/auth/refresh")
      ? json({
          accessToken: "access-" + JSON.parse(c.body).refreshToken,
          refreshToken: "rotated-" + JSON.parse(c.body).refreshToken,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      : unavailable,
  );
  t.after(() => f.close());
  const a = account({ type: "oauth", access: "old-a", refresh: "a", expires: 1 });
  const b = account({ type: "oauth", access: "old-b", refresh: "b", expires: 1 });
  await Promise.all([f.driver("cline").models(a.context), f.driver("cline").models(b.context)]);
  assert.equal(a.read().refresh, "rotated-a");
  assert.equal(b.read().refresh, "rotated-b");
  assert.equal(a.writes.length, 1);
  assert.equal(b.writes.length, 1);
});

test("cancelled request aborts network work and cannot submit delayed refresh writes", async (t) => {
  let release!: () => void;
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (c) => {
    if (c.path.endsWith("/auth/refresh")) {
      reached();
      await barrier;
      return json({
        accessToken: "late-access",
        refreshToken: "late-refresh",
        expiresAt: Date.now() + 3_600_000,
      });
    }
    return unavailable;
  });
  t.after(() => f.close());
  const driver = f.driver("cline");
  const a = account({ type: "oauth", access: "old", refresh: "old-refresh", expires: 1 });
  const controller = new AbortController();
  a.context.signal = controller.signal;
  const pending = driver.models(a.context);
  await arrived;
  controller.abort();
  release();
  await assert.rejects(pending, /cancel/);
  await driver.dispose?.();
  assert.equal(a.writes.length, 0);
  assert.equal(a.read().refresh, "old-refresh");
});

test("one cancelled model request leaves concurrent and later requests on the same account usable", async (t) => {
  let release!: () => void;
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (c) => {
    if (!c.path.endsWith("/chat/completions")) return unavailable;
    if (JSON.parse(c.body).messages[0].content === "cancel") {
      reached();
      await barrier;
    }
    return json({
      id: "response-fixture",
      choices: [{ message: { role: "assistant", content: "alive" }, finish_reason: "stop" }],
    });
  });
  t.after(() => f.close());
  const driver = f.driver("cline");
  const a = account({ type: "api", key: "fixture-key" });
  const controller = new AbortController();
  const make = (content: string, signal?: AbortSignal) =>
    driver.fetch(
      request(
        "https://api.cline.bot/api/v1/chat/completions",
        { model: "fixture-model", messages: [{ role: "user", content }] },
        signal,
      ),
      a.context,
    );
  const cancelled = make("cancel", controller.signal);
  await arrived;
  const concurrent = make("concurrent");
  controller.abort();
  release();
  await assert.rejects(cancelled, /cancel/);
  assert.match(await (await concurrent).text(), /alive/);
  assert.match(await (await make("later")).text(), /alive/);
});

test("remaining HTTP plugin variants discover models and execute their authenticated request adapters", async (t) => {
  const f = await fixture((c) =>
    c.path.includes("/algo/api/v2/model/list")
      ? json({ chat: [{ key: "fixture-model", enable: true, max_input_tokens: 64_000 }] })
      : { status: 429, json: { error: { message: "fixture limit", code: "rate_limit" } } },
  );
  t.after(() => f.close());
  const oauth: AuthGrant = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    uid: "fixture-user",
    machineId: "fixture-machine",
    expires: Date.now() + 3_600_000,
  };
  const grants: Record<string, AuthGrant> = {
    "commandcode-plan": { type: "api", key: "fixture-key", metadata: { plan: "Pro" } },
    devin: { type: "api", key: "fixture-key" },
    kiro: { type: "api", key: "fixture-key" },
    "minimax-code": oauth,
    "minimax-code-global": oauth,
    "mimo-app": {
      ...oauth,
      access: JSON.stringify({ serviceToken: "fixture-cookie" }),
      refresh: JSON.stringify({ passToken: "fixture-pass", userId: "fixture-user" }),
    },
    qoder: oauth,
    "qoder-cn": oauth,
    "trae-cn": oauth,
    "trae-global": oauth,
    workbuddy: oauth,
    "workbuddy-ai": oauth,
    "opencode-zen-free": { type: "api", key: "public" },
  };
  for (const [channel, grant] of Object.entries(grants))
    await t.test(channel, async () => {
      const driver = f.driver(channel);
      const a = account(grant);
      const models = await driver.models(a.context);
      assert.ok(models.length, channel + " models");
      const model = models[0]!;
      const path =
        model.protocol === "anthropic-messages"
          ? "/messages"
          : model.protocol === "openai-responses"
            ? "/responses"
            : "/chat/completions";
      const body = {
        model: model.id,
        messages: [{ role: "user", content: "fixture hello" }],
        input: "fixture hello",
        max_tokens: 64,
        stream: true,
      };
      const before = f.calls.length;
      let response: Response | undefined;
      try {
        response = await driver.fetch(
          request(model.baseURL.replace(/\/$/, "") + path, body),
          a.context,
        );
      } catch (error) {
        assert.match(String(error), /fixture limit|429/, channel + " upstream error");
      }
      if (response) {
        assert.ok(response.status >= 400, `${channel}: ${response.status}`);
        await response.text();
      }
      assert.ok(f.calls.length > before, channel + " must reach its actual network adapter");
      await driver.dispose?.();
    });
});

test("Cursor's actual HTTP/2 agent transport remains isolated and returns provider errors", async (t) => {
  let requests = 0;
  const h2 = createHttp2Server();
  const sessions = new Set<ServerHttp2Session>();
  h2.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  h2.on("stream", (stream: ServerHttp2Stream) => {
    requests++;
    stream.on("error", () => {});
    stream.respond({ ":status": 429, "content-type": "application/json" });
    stream.end(JSON.stringify({ error: { code: "resource_exhausted", message: "fixture limit" } }));
  });
  await new Promise<void>((resolve) => h2.listen(0, "127.0.0.1", resolve));
  const f = await fixture((c) => {
    if (c.path.endsWith("/AvailableModels"))
      return json({
        models: [
          {
            name: "grok-4.7-fast",
            clientDisplayName: "Grok",
            contextTokenLimit: 128_000,
            supportsNonMaxMode: true,
          },
        ],
      });
    if (c.path.endsWith("/GetUsableModels"))
      return json({ models: [{ modelId: "grok-4.7-fast" }] });
    return unavailable;
  });
  t.after(async () => {
    await f.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => h2.close(() => resolve()));
  });
  const driver = f.driver("cursor", `http://127.0.0.1:${(h2.address() as AddressInfo).port}`);
  const access =
    "e30." +
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString(
      "base64url",
    ) +
    ".fixture";
  const a = account({ type: "oauth", access, refresh: "", expires: 0 });
  const models = await driver.models(a.context);
  const model = models[0]!;
  const response = await driver.fetch(
    request(model.baseURL + "/chat/completions", {
      model: model.id,
      messages: [{ role: "user", content: "fixture hello" }],
      stream: true,
    }),
    a.context,
  );
  assert.ok(response.status >= 400);
  await response.text();
  assert.ok(requests > 0, "must execute HTTP/2 agent transport");
});

test("Grok uses the explicitly selected CLI profile and signed Responses transport", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "lcode-grok-fixture-"));
  const file = join(profile, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      fixture: { key: "fixture-grok", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
    }),
  );
  const f = await fixture((c) =>
    c.path.endsWith("/responses")
      ? { status: 429, json: { error: { message: "fixture limit" } } }
      : c.path.endsWith("/models")
        ? json({ data: [{ id: "grok-4.7", api_backend: "responses" }] })
        : unavailable,
  );
  t.after(async () => {
    await f.close();
    await unlink(file);
    await rmdir(profile);
  });
  const driver = f.driver("grok");
  const a = account({
    type: "oauth",
    access: "fixture-grok",
    refresh: profile,
    expires: Date.now() + 3_600_000,
  });
  const models = await driver.models(a.context);
  const model = models[0]!;
  assert.equal(model.protocol, "openai-responses");
  const response = await driver.fetch(
    request(model.baseURL + "/responses", { model: model.id, input: "fixture hello" }),
    a.context,
  );
  assert.equal(response.status, 429);
  await response.text();
  const call = f.calls.find((c) => c.path.endsWith("/responses"))!;
  assert.equal(call.headers.authorization, "Bearer fixture-grok");
  assert.equal(call.headers["x-xai-token-auth"], "xai-grok-cli");
});
