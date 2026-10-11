import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeCommand } from "./claude-command.js";

async function workspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lcode-claude-resolver-"));
  try {
    await run(root);
  } finally {
    const path = resolve(root);
    assert.equal(dirname(path), resolve(tmpdir()));
    assert.ok(basename(path).startsWith("lcode-claude-resolver-"));
    await rm(path, { recursive: true, force: true });
  }
}

test("Windows prefers native Claude executable over an earlier npm shim", async () =>
  workspace(async (root) => {
    const npm = join(root, "npm");
    const native = join(root, "native");
    await mkdir(npm);
    await mkdir(native);
    await writeFile(join(npm, "claude.cmd"), "@echo shim");
    await writeFile(join(native, "claude.exe"), "fixture");
    const command = await resolveClaudeCommand({
      platform: "win32",
      environment: { Path: `${npm};${native}` },
      nodeExecutable: "fixture-node",
    });
    assert.deepEqual(command, { command: join(native, "claude.exe"), prefix: [], node: false });
  }));

test("Windows resolves npm shim to Node JavaScript without evaluating shell content", async () =>
  workspace(async (root) => {
    const directory = join(root, "npm & spaces");
    const pkg = join(directory, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(pkg, { recursive: true });
    const entry = join(pkg, "cli.js");
    await writeFile(entry, "/* fixture */");
    const shim = join(directory, "claude.cmd");
    await writeFile(
      shim,
      '@echo off\r\nset ignored=do-not-execute\r\n"node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    for (const environment of [{ PATH: directory }, { LCODE_CLAUDE_BIN: shim }]) {
      const command = await resolveClaudeCommand({
        platform: "win32",
        environment,
        nodeExecutable: "trusted-node",
      });
      assert.deepEqual(command, { command: "trusted-node", prefix: [entry], node: true });
    }
  }));

test("Windows handles npm package bin metadata and explicitly selected CLI JavaScript", async () =>
  workspace(async (root) => {
    const pkg = join(root, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(pkg, { recursive: true });
    const entry = join(pkg, "entry.cjs");
    await writeFile(entry, "/* fixture */");
    const shim = join(root, "claude.cmd");
    await writeFile(shim, "rem unsupported wrapper text");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ bin: { claude: "entry.cjs" } }));
    for (const selected of [shim, entry]) {
      const command = await resolveClaudeCommand({
        platform: "win32",
        environment: { LCODE_CLAUDE_BIN: selected },
        nodeExecutable: "trusted-node",
      });
      assert.deepEqual(command, { command: "trusted-node", prefix: [entry], node: true });
    }
  }));

test("Windows rejects arbitrary batch launchers instead of enabling a shell", async () =>
  workspace(async (root) => {
    const shim = join(root, "custom.cmd");
    await writeFile(shim, "@echo off\r\necho arbitrary-command\r\n");
    await assert.rejects(
      resolveClaudeCommand({ platform: "win32", environment: { LCODE_CLAUDE_BIN: shim } }),
      /Claude Code CLI is required/,
    );
  }));
