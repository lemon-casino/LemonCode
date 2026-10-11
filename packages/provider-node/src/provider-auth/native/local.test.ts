import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAccount, followLocal, saveLocalCodex } from "./local.js";
import { defaultLocalIO, type LocalIO } from "./local-io.js";

const idToken = (workspace: string, email = "fixture@example.test") =>
  "x." +
  Buffer.from(
    JSON.stringify({
      email,
      "https://api.openai.com/auth": { chatgpt_account_id: workspace, chatgpt_plan_type: "plus" },
    }),
  ).toString("base64url") +
  ".x";
test("Codex local discovery follows custom home, guards identity switches and writes rotated tokens back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-local-test-"));
  try {
    const path = join(dir, "auth.json");
    const original = {
      tokens: {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        id_token: idToken("one"),
        account_id: "one",
      },
      extra: "preserved",
    };
    await writeFile(path, JSON.stringify(original));
    const io: LocalIO = {
      ...defaultLocalIO,
      home: dir,
      environment: { CODEX_HOME: dir },
      run: async () => "",
    };
    const grant = await localAccount("codex", io, new AbortController().signal);
    assert.ok(grant.identityKey);
    assert.equal(grant.displayName, "fixture@example.test");
    await saveLocalCodex(grant, { ...grant, access: "rotated", refresh: "rotated-refresh" }, io);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.tokens.access_token, "rotated");
    assert.equal(saved.extra, "preserved");
    assert.equal(
      (await followLocal(grant, io, new AbortController().signal)).refresh,
      "rotated-refresh",
    );
    await writeFile(
      path,
      JSON.stringify({
        ...original,
        tokens: { ...original.tokens, id_token: idToken("two"), account_id: "two" },
      }),
    );
    await assert.rejects(
      followLocal(grant, io, new AbortController().signal),
      /changed|signed out/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Gemini local source is client-checked and remains read-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-local-test-"));
  try {
    await mkdir(join(dir, ".gemini"));
    const path = join(dir, ".gemini", "oauth_creds.json");
    await writeFile(
      path,
      JSON.stringify({
        access_token: "a",
        refresh_token: "r",
        id_token:
          "x." +
          Buffer.from(JSON.stringify({ aud: "another-client" })).toString("base64url") +
          ".x",
      }),
    );
    const io: LocalIO = { ...defaultLocalIO, home: dir, environment: {}, run: async () => "" };
    await assert.rejects(localAccount("gemini", io, new AbortController().signal), /OAuth client/);
    await writeFile(path, JSON.stringify({ access_token: "a", refresh_token: "r" }));
    await writeFile(
      join(dir, ".gemini", "google_accounts.json"),
      JSON.stringify({ active: "fixture@example.test" }),
    );
    await writeFile(join(dir, ".gemini", ".env"), 'GOOGLE_CLOUD_PROJECT="fixture-project"\n');
    const grant = await localAccount("gemini", io, new AbortController().signal);
    assert.equal(grant.projectId, "fixture-project");
    assert.equal(grant.email, "fixture@example.test");
    const refreshed = {
      ...grant,
      access: "managed-fresh",
      expires: Date.now() + 3600000,
      projectReady: true,
    };
    assert.equal(
      (await followLocal(refreshed, io)).access,
      "managed-fresh",
      "unchanged CLI source must not overwrite a freshly renewed account",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude Mac keychain and Copilot Linux secret service use explicit platform adapters", async () => {
  const commands: string[][] = [];
  const io: LocalIO = {
    platform: "darwin",
    home: "/fixture",
    environment: { USER: "fixture" },
    read: async (path) => {
      if (path.endsWith(".claude.json"))
        return JSON.stringify({
          oauthAccount: { emailAddress: "fixture@example.test", organizationUuid: "org" },
        });
      throw new Error("absent");
    },
    write: async () => {
      throw new Error("must not write");
    },
    run: async (command, args) => {
      commands.push([command, ...args]);
      return JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    },
  };
  const claude = await localAccount("claude", io, new AbortController().signal);
  assert.equal(claude.email, "fixture@example.test");
  assert.ok(commands[0]?.includes("Claude Code-credentials"));
  const linux: LocalIO = {
    ...io,
    platform: "linux",
    read: async (path) => {
      if (path.endsWith("config.json"))
        return JSON.stringify({
          lastLoggedInUser: { host: "https://github.com", login: "fixture" },
        });
      throw new Error("absent");
    },
    run: async (command, args) => {
      commands.push([command, ...args]);
      return "fixture-cli-token";
    },
  };
  const copilot = await localAccount("copilot", linux, new AbortController().signal);
  assert.equal(copilot.copilotMode, "cli");
  assert.equal(copilot.access, "fixture-cli-token");
  assert.ok(commands.at(-1)?.includes("copilot-cli"));
});

test("Windows Copilot reads JSONC from running WSL and editor github account wins", async () => {
  const editor = JSON.stringify({
    "github.com:fixture": { user: "editor", oauth_token: "editor-token" },
  });
  let hasEditor = false;
  const io: LocalIO = {
    platform: "win32",
    home: "C:\\fixture",
    environment: {},
    wslHomes: async () => ["\\\\wsl.localhost\\Fixture\\home\\user"],
    write: async () => {
      throw new Error("readonly");
    },
    run: async () => {
      throw new Error("no process");
    },
    read: async (path) => {
      if (hasEditor && path.endsWith("apps.json")) return editor;
      if (path.includes("wsl.localhost") && path.endsWith("config.json"))
        return '{ // CLI comment\n"lastLoggedInUser":{"host":"https://github.com","login":"cli"},"copilotTokens":{"https://github.com:cli":"cli-token",},}';
      throw new Error("missing");
    },
  };
  assert.equal((await localAccount("copilot", io)).copilotMode, "cli");
  hasEditor = true;
  assert.equal((await localAccount("copilot", io)).username, "editor");
});

test("Claude logout is authoritative even while a stale local profile survives", async () => {
  const io: LocalIO = {
    platform: "linux",
    home: "/fixture",
    environment: {},
    write: async () => {},
    run: async () => JSON.stringify({ loggedIn: false }),
    read: async (path) =>
      JSON.stringify(
        path.endsWith(".credentials.json")
          ? { claudeAiOauth: { accessToken: "a", refreshToken: "r" } }
          : { oauthAccount: { emailAddress: "old@example.test", organizationUuid: "org" } },
      ),
  };
  await assert.rejects(localAccount("claude", io), /changed|signed out/);
});
