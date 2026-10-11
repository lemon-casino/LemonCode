import assert from "node:assert/strict";
import { test } from "node:test";
import { importChallenge, parseImportFiles } from "./imports.js";

test("Claude file imports preserve explicit scopes in both string and array formats", () => {
  const rows = parseImportFiles(
    "claude",
    JSON.stringify([
      {
        content: JSON.stringify([
          {
            claudeAiOauth: { refreshToken: "fixture-one", scopes: "user:inference   user:profile" },
          },
          {
            platform: "anthropic",
            type: "oauth",
            credentials: { refresh_token: "fixture-two", scopes: ["user:inference"] },
          },
        ]),
      },
    ]),
  );
  assert.deepEqual((rows[0]!.credentials!.claudeAiOauth as { scopes: string[] }).scopes, [
    "user:inference",
    "user:profile",
  ]);
  assert.deepEqual((rows[1]!.credentials!.claudeAiOauth as { scopes: string[] }).scopes, [
    "user:inference",
  ]);
});

test("Codex imports native, CPA, Sub2API, codexbar and refresh lines without merging workspaces", () => {
  const files = [
    {
      name: "auth.json",
      content: JSON.stringify({ tokens: { refresh_token: "a", account_id: "one" } }),
    },
    {
      name: "cpa",
      content: JSON.stringify([
        { type: "codex", refreshToken: "b" },
        {
          platform: "openai",
          type: "oauth",
          credentials: { refresh_token: "c", chatgpt_account_id: "two" },
        },
      ]),
    },
    {
      name: "bar",
      content: JSON.stringify({
        providers: [
          {
            kind: "openai_oauth",
            accounts: [{ kind: "oauth_tokens", refreshToken: "d", openAIAccountId: "three" }],
          },
        ],
        openAI: { remoteConnectionAccounts: [{ refreshToken: "d" }] },
      }),
    },
    { name: "tokens", content: "# comment\ne\n\nf" },
  ];
  const items = parseImportFiles("codex", JSON.stringify(files));
  assert.deepEqual(
    items.map((item) => item.refresh),
    ["a", "b", "c", "d", "e", "f"],
  );
  assert.equal(items[0]?.accountId, "one");
  assert.equal(items[2]?.accountId, "two");
  assert.equal(items[3]?.accountId, "three");
});

test("import parser rejects incompatible, access-only and invalid input without leaking source", () => {
  const items = parseImportFiles(
    "codex",
    JSON.stringify([
      {
        content: JSON.stringify([
          { type: "claude", refresh_token: "private-secret" },
          { access_token: "private-secret" },
          { OPENAI_API_KEY: "private-secret" },
        ]),
      },
      { content: "{private-secret" },
    ]),
  );
  assert.equal(items.length, 4);
  assert.ok(items.every((item) => item.error));
  assert.equal(JSON.stringify(items).includes("private-secret"), false);
  assert.throws(
    () => parseImportFiles("codex", JSON.stringify([{ content: "x".repeat(4 * 1024 * 1024 + 1) }])),
    /size/,
  );
  assert.throws(
    () =>
      parseImportFiles(
        "codex",
        JSON.stringify([{ content: JSON.stringify(Array.from({ length: 201 }, () => "x")) }]),
      ),
    /200/,
  );
});

test("Claude and Google importer retain scopes/project and reject another OAuth client", () => {
  const claude = parseImportFiles(
    "claude",
    JSON.stringify([
      {
        content: JSON.stringify({
          email: "fixture@example.test",
          claudeAiOauth: { accessToken: "a", refreshToken: "b", scopes: ["user:inference"] },
        }),
      },
    ]),
  )[0]!;
  assert.equal(claude.email, "fixture@example.test");
  assert.equal(claude.refresh, "b");
  const google = parseImportFiles(
    "antigravity",
    JSON.stringify([
      {
        content: JSON.stringify({
          accounts: [
            {
              email: "fixture@example.test",
              token: { refresh_token: "r", project_id: "test-project" },
            },
            { type: "gemini", refresh_token: "wrong" },
          ],
        }),
      },
    ]),
  );
  assert.equal(google[0]?.projectId, "test-project");
  assert.ok(google[1]?.error);
});

test("batch import bounds concurrency, deduplicates tokens and returns per-item safe failures", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const challenge = importChallenge(
    "codex",
    { files: JSON.stringify([{ content: JSON.stringify(["a", "b", "c", "d", "e", "a"]) }]) },
    new AbortController().signal,
    async (item, signal) => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      signal.throwIfAborted();
      active--;
      if (item.refresh === "c") throw new Error("private-secret");
      return {
        type: "oauth",
        refresh: item.refresh,
        identityKey: item.refresh,
        displayName: "Fixture",
      };
    },
  );
  const result = await challenge.completeMany!();
  assert.equal(calls, 5);
  assert.ok(max <= 4);
  assert.deepEqual(
    result.map((r) => r.status),
    ["ready", "ready", "failed", "ready", "ready", "exists"],
  );
  assert.equal(
    JSON.stringify(result.filter((r) => r.status !== "ready")).includes("private-secret"),
    false,
  );
  assert.equal(await challenge.completeMany!(), result);
});

test("cancelled batch never returns accepted results", async () => {
  const controller = new AbortController();
  const challenge = importChallenge(
    "codex",
    { files: JSON.stringify([{ content: "a" }]) },
    controller.signal,
    async (_item, signal) => {
      controller.abort();
      signal.throwIfAborted();
      return { type: "oauth" };
    },
  );
  await assert.rejects(challenge.completeMany!(), /abort/i);
});

test("batch cancellation settles even when a validation transport ignores abort", async () => {
  const controller = new AbortController();
  const challenge = importChallenge(
    "codex",
    { files: JSON.stringify([{ content: "fixture" }]) },
    controller.signal,
    async () => new Promise(() => {}),
  );
  const pending = challenge.completeMany!();
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test("batch deadline retains renewed accounts and reports unfinished items instead of dropping all results", async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const challenge = importChallenge(
      "codex",
      { files: JSON.stringify([{ content: '["fast","slow"]' }]) },
      new AbortController().signal,
      async (item) =>
        item.refresh === "fast" ? { type: "oauth", refresh: "renewed" } : new Promise(() => {}),
      { totalMs: 30, itemMs: 100 },
    );
    const results = await challenge.completeMany!();
    assert.deepEqual(
      results.map((r) => r.status),
      ["ready", "failed"],
    );
    if (results[0]?.status === "ready") assert.equal(results[0].grant.refresh, "renewed");
  } finally {
    clearTimeout(keepAlive);
  }
});
