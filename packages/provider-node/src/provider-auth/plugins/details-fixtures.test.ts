import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AuthDriver, AuthDriverContext, AuthGrant } from "../driver.js";
import { createPluginAuthFixtureDriver } from "../plugins.js";

async function fixture(
  route: (request: {
    url: string;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
  }) =>
    | { status?: number; body?: unknown; headers?: Record<string, string> }
    | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
  home?: string,
) {
  const calls: { url: string; headers: import("node:http").IncomingHttpHeaders; body: string }[] =
    [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const call = { url: req.url!, headers: req.headers, body: Buffer.concat(parts).toString() };
    calls.push(call);
    const reply = await route(call);
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const drivers: AuthDriver[] = [];
  return {
    calls,
    driver(channel: string) {
      const driver = createPluginAuthFixtureDriver(
        channel,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        undefined,
        home,
      )!;
      drivers.push(driver);
      return driver;
    },
    async close() {
      await Promise.all(drivers.map((driver) => driver.dispose?.()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function context(grant: AuthGrant, statuses: string[] = []): AuthDriverContext {
  return {
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
    reportSignIn: async (status) => {
      statuses.push(status);
    },
  };
}
test("worker preserves local metadata and Factory import callback batches validated identities", async (t) => {
  const f = await fixture(({ url, headers }) =>
    url === "/api/cli/whoami"
      ? {
          body: {
            userId: "person",
            orgId: headers.authorization?.includes("first") ? "org-a" : "org-b",
            email: "fixture@example.invalid",
          },
        }
      : { status: 404 },
  );
  t.after(() => f.close());
  for (const [channel, id] of [
    ["bigmodel", "2"],
    ["zai", "2"],
    ["commandcode-plan", "1"],
    ["cursor", "1"],
    ["devin", "1"],
    ["grok", "1"],
    ["kiro", "1"],
    ["workbuddy", "1"],
    ["workbuddy-ai", "1"],
  ]) {
    const method = (await f.driver(channel!).methods()).find((m) => m.id === id)!;
    assert.equal(method.kind, "local");
    assert.ok(method.description);
  }
  assert.equal(f.calls.length, 0);
  const driver = f.driver("factory");
  const methods = await driver.methods();
  assert.equal(methods.find((m) => m.id === "1")?.fields?.[0]?.placeholder, "fk-…");
  assert.equal(methods.find((m) => m.id === "import-files")?.kind, "import");
  const challenge = await driver.authorize(
    "import-files",
    {
      files: JSON.stringify([
        { name: "keys.env", content: "fk-first_12345678\nfk-second_12345678\nfk-first_12345678" },
      ]),
    },
    new AbortController().signal,
  );
  const entries = await challenge.completeMany!();
  assert.equal(entries.length, 2);
  assert.equal(f.calls.length, 2);
  assert.ok(entries.every((entry) => entry.status === "ready"));
  const identities = entries.flatMap((entry) =>
    entry.status === "ready" ? [entry.grant.identityKey] : [],
  );
  assert.notEqual(identities[0], identities[1]);
  await assert.rejects(challenge.completeMany!());
});

test("worker reports model fallback and preserves real reasoning variants", async (t) => {
  const f = await fixture(() => ({ status: 503 }));
  t.after(() => f.close());
  const result = await f.driver("commandcode-plan").modelCatalog!(
    context({ type: "api", key: "fixture-key" }),
  );
  assert.equal(result.fallback, true);
  assert.ok(result.models.length > 0);
  const factory = await f.driver("factory").modelCatalog!(
    context({ type: "api", key: "fk-fixture1234" }),
  );
  assert.ok(
    factory.models.some((m) =>
      m.reasoningVariants?.some((v) => v.options.effort || v.options.reasoningEffort),
    ),
  );
});

test("worker handles private sign-in status without forwarding its response header", async (t) => {
  const f = await fixture(({ url }) =>
    url.endsWith("/messages")
      ? { body: { type: "message", content: [] }, headers: { "X-Magpie-Sign-In": "kept" } }
      : { body: { userId: "user", email: "fixture@example.invalid" } },
  );
  t.after(() => f.close());
  const statuses: string[] = [];
  const driver = f.driver("factory");
  const ctx = context({ type: "api", key: "fk-fixture1234", metadata: { region: "" } }, statuses);
  const models = await driver.models(ctx);
  const model = models.find((m) => m.protocol === "anthropic-messages")!;
  const response = await driver.fetch(
    new Request(model.baseURL + "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
      }),
    }),
    ctx,
  );
  await response.text();
  assert.deepEqual(statuses, ["kept"]);
  assert.equal(response.headers.get("x-magpie-sign-in"), null);
});

function encrypted(value: string) {
  const key = createHash("sha256").update("fixture-secret").digest();
  const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
test("worker local ZCode authorization and actual fetch remain site-scoped with both sites present", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-worker-local-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "credentials.json");
  const contents = JSON.stringify({
    "account-provider:coding-plan:account:zai-individual-coding-plan:account:a:api-key":
      encrypted("zai.fixture"),
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:b:api-key":
      encrypted("bigmodel.fixture"),
  });
  await writeFile(path, contents);
  const f = await fixture(
    ({ url }) =>
      url.endsWith("/messages")
        ? { body: { type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } } }
        : { status: 503 },
    home,
  );
  t.after(() => f.close());
  for (const channel of ["bigmodel", "zai"]) {
    const driver = f.driver(channel);
    const challenge = await driver.authorize("2", {}, new AbortController().signal);
    const grant = await challenge.complete();
    assert.equal(JSON.parse(grant.refresh!).site, channel);
    const ctx = context(grant);
    const [model] = await driver.models(ctx);
    assert.ok(model);
    const response = await driver.fetch(
      new Request(model.baseURL + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "fixture" }],
          max_tokens: 10,
        }),
      }),
      ctx,
    );
    await response.text();
    const sent = f.calls.filter((call) => call.url.endsWith("/messages")).at(-1)!;
    assert.ok(
      [sent.headers.authorization, sent.headers["x-api-key"]].some((value) =>
        String(value).includes(`${channel}.fixture`),
      ),
    );
  }
  assert.equal(await readFile(path, "utf8"), contents);
});

test("worker import cancellation prevents late batch results", async (t) => {
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async () => {
    started();
    await gate;
    return { body: { userId: "late", email: "late@example.invalid" } };
  });
  t.after(() => f.close());
  const controller = new AbortController();
  const challenge = await f
    .driver("factory")
    .authorize(
      "import-files",
      { files: JSON.stringify([{ name: "keys", content: "fk-fixture12345678" }]) },
      controller.signal,
    );
  const completion = challenge.completeMany!();
  await reached;
  controller.abort();
  release();
  await assert.rejects(
    completion,
    (error) => error instanceof Error && error.name === "AbortError",
  );
});

test("worker expires changed ZCode identity before any upstream request or grant write", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-worker-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "credentials.json");
  const source = (user: string) =>
    JSON.stringify({
      "account-provider:coding-plan:account:zai-individual-coding-plan:account:a:api-key":
        encrypted(`${user}.fixture`),
      "oauth:zai:user_info": encrypted(JSON.stringify({ user_id: user })),
    });
  await writeFile(path, source("original"));
  const f = await fixture(() => ({ status: 503 }), home);
  t.after(() => f.close());
  const driver = f.driver("zai");
  const grant = await (await driver.authorize("2", {}, new AbortController().signal)).complete();
  const statuses: string[] = [];
  const ctx = context(grant, statuses);
  await writeFile(path, source("other"));
  await assert.rejects(driver.models(ctx), /sign-in changed/);
  assert.deepEqual(statuses, ["expired"]);
  assert.deepEqual(await ctx.read(), grant);
  assert.equal(f.calls.length, 0);
});
