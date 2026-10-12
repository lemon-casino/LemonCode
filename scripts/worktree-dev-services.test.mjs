import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { readMiseNotices } from "./third-party-notices.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";

const git = promisify(execFile);
const sourceRoot = new URL("../", import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lcode dev services "));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("server package script preserves the full onSuccess command through the platform shell", async (t) => {
  const root = await fixture(t);
  const pkg = JSON.parse(await readFile(new URL("packages/server/package.json", sourceRoot)));
  const reporter = join(root, "reporter.mjs");
  await writeFile(reporter, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const windows = process.platform === "win32";
  await writeFile(
    join(root, windows ? "tsup.cmd" : "tsup"),
    windows
      ? `@echo off\r\n"${process.execPath}" "${reporter}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath}' '${reporter}' "$@"\n`,
    { mode: 0o755 },
  );
  const env = withPinnedNodePath(process.env, process.execPath);
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  env[pathKey] = `${root}${delimiter}${env[pathKey]}`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(pkg.scripts.dev, [], {
      shell: true,
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "--watch",
    "--onSuccess",
    "node dist/entry-http.js",
  ]);
});

test("autocrlf Git worktree preserves approved mise license bytes and still rejects content changes", async (t) => {
  const root = await fixture(t);
  const origin = join(root, "origin");
  const checkout = join(root, "checkout");
  await mkdir(join(origin, "third-party/mise"), { recursive: true });
  for (const file of [
    ".gitattributes",
    "third-party/mise/LICENSE.txt",
    "third-party/mise/sources.json",
  ])
    await writeFile(join(origin, file), await readFile(new URL(file, sourceRoot)));
  const run = (args) => git("git", ["-C", origin, ...args]);
  await run(["init", "--quiet"]);
  await run(["config", "core.autocrlf", "true"]);
  await run(["config", "core.safecrlf", "false"]);
  await run([
    "add",
    "-f",
    ".gitattributes",
    "third-party/mise/LICENSE.txt",
    "third-party/mise/sources.json",
  ]);
  await run([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  await run(["worktree", "add", "--detach", checkout]);
  const license = await readFile(join(checkout, "third-party/mise/LICENSE.txt"));
  assert.deepEqual(license, await readFile(join(origin, "third-party/mise/LICENSE.txt")));
  await readMiseNotices(checkout, { verify: true });
  await writeFile(
    join(checkout, "third-party/mise/LICENSE.txt"),
    Buffer.concat([license, Buffer.from("altered content\n")]),
  );
  await assert.rejects(readMiseNotices(checkout, { verify: true }), /Changed mise license/);
});
