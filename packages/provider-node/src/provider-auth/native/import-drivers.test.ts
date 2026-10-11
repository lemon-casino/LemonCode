import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAIAuthDriver } from "./openai.js";
import { GoogleAuthDriver } from "./google.js";
import { ClaudeAuthDriver } from "./claude.js";
import { record } from "./common.js";
import { ClaudeProfile } from "./claude-process.js";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthGrant } from "../driver.js";
const files = (content: unknown) => ({
  files: JSON.stringify([{ name: "fixture.json", content: JSON.stringify(content) }]),
});
const token = (value: unknown) =>
  "fixture." + Buffer.from(JSON.stringify(value)).toString("base64url") + ".fixture";

test("Codex batch validates refresh tokens and preserves different workspaces for one email", async () => {
  const driver = new OpenAIAuthDriver("codex", async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    const workspace = form.get("refresh_token");
    return Response.json({
      access_token: "renewed",
      refresh_token: workspace + "-renewed",
      expires_in: 3600,
      id_token: token({
        email: "fixture@example.test",
        "https://api.openai.com/auth": { chatgpt_account_id: workspace },
      }),
    });
  });
  const challenge = await driver.authorize(
    "files",
    files(["one", "two"]),
    new AbortController().signal,
  );
  const results = await challenge.completeMany!();
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === "ready"));
  if (results[0]?.status === "ready" && results[1]?.status === "ready") {
    assert.notEqual(results[0].grant.identityKey, results[1].grant.identityKey);
    assert.equal(results[0].grant.displayName, "fixture@example.test");
  }
  driver.dispose();
});

test("Google import verifies its OAuth client, identity and Code Assist project before ready", async () => {
  const urls: string[] = [];
  const driver = new GoogleAuthDriver("antigravity", async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/token")) {
      assert.match(String(init?.body), /1071006060591/);
      return Response.json({ access_token: "renewed", expires_in: 3600 });
    }
    if (url.includes("userinfo"))
      return Response.json({ email: "fixture@example.test", id: "fixture-user" });
    if (url.endsWith(":loadCodeAssist"))
      return Response.json({
        cloudaicompanionProject: "verified-project",
        currentTier: { id: "paid", name: "Paid" },
      });
    throw new Error("unexpected endpoint");
  });
  const challenge = await driver.authorize(
    "files",
    files([{ refresh_token: "fixture-refresh" }, { type: "codex", refresh_token: "wrong" }]),
    new AbortController().signal,
  );
  const results = await challenge.completeMany!();
  assert.deepEqual(
    results.map((r) => r.status),
    ["ready", "failed"],
  );
  if (results[0]?.status === "ready") {
    assert.equal(results[0].grant.projectId, "verified-project");
    assert.ok(results[0].grant.identityKey);
    assert.equal(results[0].grant.plan, "Paid");
  }
  assert.equal(urls.length, 3);
  driver.dispose();
});

test("Claude import keeps explicit identity and defers token refresh to CLI without external HTTP", async () => {
  const driver = new ClaudeAuthDriver(async () => {
    throw new Error("CLI not installed");
  });
  const challenge = await driver.authorize(
    "files",
    files({ email: "fixture@example.test", claudeAiOauth: { refreshToken: "fixture-refresh" } }),
    new AbortController().signal,
  );
  const results = await challenge.completeMany!();
  assert.equal(results[0]?.status, "ready");
  if (results[0]?.status === "ready") {
    assert.ok(results[0].grant.identityKey);
    assert.equal(results[0].grant.expires, 1);
    assert.ok(
      Array.isArray(record(record(results[0].grant.claudeCredentials).claudeAiOauth).scopes),
    );
  }
  await driver.dispose();
});

test("Claude local profile is borrowed and is never removed on disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-local-profile-fixture-"));
  try {
    const profile = new ClaudeProfile();
    const grant: AuthGrant = { type: "oauth", localSource: { channel: "claude", dir } };
    assert.equal(await profile.get(grant), dir);
    await profile.dispose();
    await access(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ChatGPT API uses the Host's stable identity and rejects absent identity", async () => {
  const driver = new OpenAIAuthDriver("chatgpt-api", async () => {
    throw new Error("no HTTP expected");
  });
  await assert.rejects(
    driver.authorize("browser", {}, new AbortController().signal),
    /installation identity/,
  );
  const controller = new AbortController(),
    hostId = "urn:uuid:00000000-0000-4000-8000-000000000001";
  const challenge = await driver.authorize("browser", { hostId }, controller.signal);
  assert.equal(new URL(challenge.url!).searchParams.get("ext_agent_host_id"), hostId);
  const pending = challenge.complete();
  controller.abort();
  await assert.rejects(pending);
  driver.dispose();
});
