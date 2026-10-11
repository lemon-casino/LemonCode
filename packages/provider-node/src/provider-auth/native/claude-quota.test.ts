import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { ClaudeAuthDriver } from "./claude.js";
import { claudeEnvironment, claudeGrant, type ClaudeSpawner } from "./claude-process.js";
import { parseClaudeUsage, runClaudeQuota } from "./claude-quota.js";
import type { AuthDriverContext } from "../driver.js";
import { record, list } from "./common.js";

test("Claude usage parses real CLI windows, zero, model scope and timezone reset formats", () => {
  const result = parseClaudeUsage(
    `Current session: 13% used · resets Oct 1 at 3:30pm (Asia/Shanghai)
Current week (all models): 4% used · resets Oct 3, 2pm (Asia/Shanghai)
Current week (Opus): 12.5% used
Current week (Fable): 0% used
Current week (Fable): 0% used`,
    Date.parse("2026-10-01T04:00:00Z"),
  );
  assert.deepEqual(
    result.windows.map((w) => [w.name, w.used]),
    [
      ["5 hours", 13],
      ["7 days", 4],
      ["7 days · Opus", 12.5],
      ["7 days · Fable", 0],
    ],
  );
  assert.equal(result.windows[0]?.resetsAt, "2026-10-01T07:30:00.000Z");
  assert.equal(result.windows[1]?.resetsAt, "2026-10-03T06:00:00.000Z");
  const dst = parseClaudeUsage(
    "Current session: 20% used · resets Nov 1 at 1:30am (America/New_York)",
    Date.parse("2026-11-01T06:00:00Z"),
  );
  assert.equal(dst.windows[0]?.resetsAt, "2026-11-01T06:30:00.000Z");
  const unknown = parseClaudeUsage(
    "Current session: 20% used · resets Oct 1 at 3pm (Invalid/Zone)",
  );
  assert.equal(unknown.windows[0]?.resetsAt, undefined);
  assert.equal(
    parseClaudeUsage("Current session: 20% used · resets Feb 31 at 3pm (UTC)").windows[0]?.resetsAt,
    undefined,
  );
});

test("Claude malformed, unsupported and denied output never leaves raw CLI text", () => {
  assert.deepEqual(
    parseClaudeUsage("You are currently using your subscription to power your Claude Code usage"),
    { windows: [] },
  );
  assert.equal(parseClaudeUsage("Unknown command: /usage").supported, false);
  for (const raw of [
    "Error: not logged in fixture-secret",
    "Current session: 20% used\n401 access token fixture-secret",
    "You have hit your limit, fixture-secret",
  ]) {
    const result = parseClaudeUsage(raw);
    assert.equal(result.error, "request_failed");
    assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  }
});

function fixture(mode = "success") {
  const dirs: string[] = [],
    children: ReturnType<typeof spawn>[] = [],
    argsSeen: string[][] = [];
  const script = `import {readFile,writeFile} from 'node:fs/promises';
const mode=process.argv[1];
if(mode==='hold')setInterval(()=>{},1000);
else if(mode==='oversize')process.stdout.write('x'.repeat(300000));
else if(mode==='failed'){process.stderr.write('fixture-secret');process.exitCode=1;}
else { const c=JSON.parse(await readFile('.credentials.json','utf8')); c.claudeAiOauth.accessToken+='-refreshed';await writeFile('.credentials.json',JSON.stringify(c));process.stdout.write(JSON.stringify([{type:'result',result:'Current session: 12% used',is_error:false}])); }`;
  const runner: ClaudeSpawner = (args, dir, env) => {
    dirs.push(dir);
    argsSeen.push(args);
    assert.equal(
      env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    );
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, "--", mode], {
      cwd: dir,
      env: { ...claudeEnvironment(dir), ...env },
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    children.push(child);
    return child;
  };
  let grant = claudeGrant({
    claudeAiOauth: {
      accessToken: "fixture-only",
      refreshToken: "fixture-refresh",
      subscriptionType: "pro",
    },
  });
  const context: AuthDriverContext = {
    connectionId: "fixture-a",
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
  };
  return { driver: new ClaudeAuthDriver(runner), runner, context, dirs, children, argsSeen };
}

test("Claude quota uses fixed isolated read-only command and persists only its refreshed credential", async () => {
  const a = fixture(),
    b = fixture();
  try {
    const result = record(await a.driver.quota(a.context));
    assert.equal(record(list(result.windows)[0]).used, 12);
    assert.equal(result.plan, "pro");
    assert.deepEqual(a.argsSeen[0], [
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
    ]);
    assert.equal((await a.context.read())?.access, "fixture-only-refreshed");
    await b.driver.quota({ ...b.context, connectionId: "fixture-b" });
    assert.notEqual(a.dirs[0], b.dirs[0]);
    await assert.rejects(
      a.driver.quota({ ...a.context, connectionId: "fixture-b" }),
      /shared between accounts/,
    );
  } finally {
    await a.driver.dispose();
    await b.driver.dispose();
  }
  await assert.rejects(access(a.dirs[0]!));
});

test("Claude quota failure, missing executable, oversized output and cancellation are bounded", async () => {
  for (const mode of ["failed", "oversize"]) {
    const f = fixture(mode);
    try {
      const result = await f.driver.quota(f.context);
      assert.equal(record(result).error, "request_failed");
      assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
    } finally {
      await f.driver.dispose();
    }
  }
  const missing = new ClaudeAuthDriver(async () => {
    throw new Error("private executable path");
  });
  try {
    assert.equal(record(await missing.quota(fixture().context)).supported, false);
  } finally {
    await missing.dispose();
  }
  const f = fixture("hold"),
    controller = new AbortController();
  const reading = f.driver.quota({ ...f.context, signal: controller.signal });
  while (!f.children.length) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(reading, /abort|cancel/i);
  await f.driver.dispose();
  assert.ok(f.children[0]?.killed);
  await assert.rejects(access(f.dirs[0]!));
});

test("Claude usage runner times out and releases its child", async () => {
  const f = fixture("hold");
  const result = await runClaudeQuota(f.runner, process.cwd(), new AbortController().signal, 20);
  assert.equal(result.error, "request_failed");
  assert.ok(f.children[0]?.killed);
});
