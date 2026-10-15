// Copyright 2026 Lemon (zcode-full). SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { verifyReleaseInputs } from "./verify-release-inputs.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  "LICENSE",
  "NOTICE.md",
  ".gitignore",
  ".gitattributes",
  ".github/workflows/desktop-release.yml",
  "scripts/verify-release-inputs.mjs",
  "scripts/third-party-notices.mjs",
  "scripts/verify-release-version.mjs",
];

async function fixture(t, { input = "source.txt", contents = "source\n", ignore = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zcode-release-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "global-config"),
  };
  const git = (args, { input, ...options } = {}) =>
    new Promise((done, reject) => {
      const child = execFile("git", args, { cwd: root, env, ...options }, (error, stdout, stderr) =>
        error ? reject(error) : done({ stdout, stderr }),
      );
      child.stdin.end(input);
    });
  const put = async (file, bytes) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), bytes);
  };
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Release fixture"]);
  await git(["config", "user.email", "release@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  await put("global-ignore", "*.txt\n");
  await git(["config", "--global", "core.excludesFile", join(root, "global-ignore")]);
  for (const file of controls) await put(file, file === ".gitignore" ? "global-*\n" : "control\n");
  await put("package.json", '{"version":"1.2.3"}\n');
  const bytes = Buffer.from("Preserved upstream notices\n");
  const reviewRequired = Array.from({ length: 20 }, (_, n) => ({
    id: `material-${n}`,
    reason: "Recorded gap",
  }));
  const manifest = {
    schemaVersion: 1,
    noticesSha256: hash(bytes),
    inputs: { [input]: hash(contents.replaceAll("\r\n", "\n")) },
    reviewRequired,
  };
  const saveManifest = () => put("third-party/inventory.json", JSON.stringify(manifest));
  await put("THIRD-PARTY-NOTICES.md", bytes);
  await put(
    "third-party/release-review-baseline.json",
    JSON.stringify({ schemaVersion: 1, reviewRequired }),
  );
  await saveManifest();
  await put(input, contents);
  await git(["add", "."]);
  if (!ignore) await git(["add", "--force", "--", input]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  return { root, git, put, input, manifest, saveManifest };
}

test("ignored local input cannot hide missing HEAD or index; staging does not repair HEAD", async (t) => {
  const f = await fixture(t, { input: "third-party/upstream/original.txt", ignore: true });
  const expected = /missing.*third-party\/upstream\/original\.txt/isu;
  await assert.rejects(verifyReleaseInputs({ root: f.root, source: "HEAD" }), expected);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), expected);
  await f.git(["add", "--force", "--", f.input]);
  const before = await f.git(["status", "--porcelain=v1"]);
  const result = await verifyReleaseInputs({ root: f.root });
  assert.equal(result.source, "index");
  assert.equal(result.inputCount, 1);
  assert.equal(result.reviewRequiredCount, 20);
  assert.equal((await f.git(["status", "--porcelain=v1"])).stdout, before.stdout);
  await assert.rejects(verifyReleaseInputs({ root: f.root, source: "HEAD" }), expected);
  await f.git(["commit", "--quiet", "-m", "include missing material"]);
  assert.equal((await verifyReleaseInputs({ root: f.root, source: "HEAD" })).source, "HEAD");
});

test("snapshot verification handles large UTF-8 paths and CRLF without reading dirty worktree bytes", async (t) => {
  const contents = "large source\r\n".repeat(110000);
  const f = await fixture(t, { input: "材料目录/source with spaces.txt", contents });
  await f.put(f.input, "unstaged corruption");
  await f.put("third-party/inventory.json", "not JSON in worktree");
  await verifyReleaseInputs({ root: f.root, source: "HEAD" });
  await verifyReleaseInputs({ root: f.root });
  await f.git(["add", "--force", "--", f.input]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /Third-party input changed/u);
});

test("staged deletion and missing control files are rejected with paths", async (t) => {
  const f = await fixture(t);
  await f.git(["rm", "--cached", "--", f.input]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /missing.*source\.txt/isu);
  await f.git(["reset", "--quiet", "HEAD", "--", f.input]);
  await f.git(["rm", "--cached", "--", ".github/workflows/desktop-release.yml"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /missing.*desktop-release\.yml/isu);
});

test("changed notice bytes and review baseline remain blocking", async (t) => {
  const f = await fixture(t);
  await f.put("THIRD-PARTY-NOTICES.md", "changed");
  await f.git(["add", "--", "THIRD-PARTY-NOTICES.md"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /notices changed/u);
  await f.git(["reset", "--quiet", "HEAD", "--", "THIRD-PARTY-NOTICES.md"]);
  await f.put(
    "third-party/release-review-baseline.json",
    JSON.stringify({ schemaVersion: 1, reviewRequired: [] }),
  );
  await f.git(["add", "--", "third-party/release-review-baseline.json"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /baseline mismatch/u);
});

test("invalid inventory paths, hashes and structure fail before file reads", async (t) => {
  const f = await fixture(t);
  for (const inputs of [
    null,
    [],
    {},
    { "../outside": hash("a") },
    { "C:/outside": hash("a") },
    { "a\\b": hash("a") },
    { "/absolute": hash("a") },
    { "a//b": hash("a") },
    { "./source.txt": hash("a") },
    { "file:stream": hash("a") },
    { "source.txt": "bad" },
    { "source.txt": [hash("a")] },
  ]) {
    f.manifest.inputs = inputs;
    await f.saveManifest();
    await f.git(["add", "--", "third-party/inventory.json"]);
    await assert.rejects(verifyReleaseInputs({ root: f.root }), /Invalid release inventory/u);
  }
  await assert.rejects(
    verifyReleaseInputs({ root: f.root, source: "bad-ref" }),
    /Unsupported Git source/u,
  );
});

test("symlink, submodule and unresolved index entries cannot act as release inputs", async (t) => {
  const f = await fixture(t);
  const oid = (await f.git(["hash-object", "--stdin"], { input: "source\n" })).stdout.trim();
  await f.git(["update-index", "--cacheinfo", `120000,${oid},${f.input}`]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /regular Git blob/u);
  const commit = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
  await f.git(["update-index", "--cacheinfo", `160000,${commit},${f.input}`]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /regular Git blob/u);
  await f.git(["update-index", "--index-info"], {
    input: `0 ${"0".repeat(40)}\t${f.input}\n100644 ${oid} 1\t${f.input}\n100644 ${oid} 2\t${f.input}\n`,
  });
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /Unmerged Git index/u);
});

test("HEAD symlinks and staged LFS pointers cannot replace original material", async (t) => {
  const f = await fixture(t);
  const oid = (await f.git(["hash-object", "--stdin"], { input: "source\n" })).stdout.trim();
  await f.git(["update-index", "--cacheinfo", `120000,${oid},${f.input}`]);
  await f.git(["commit", "--quiet", "-m", "symlink input"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root, source: "HEAD" }), /regular Git blob/u);
  await f.git(["update-index", "--cacheinfo", `100644,${oid},${f.input}`]);
  await f.put(
    f.input,
    `version https://git-lfs.github.com/spec/v1\noid sha256:${hash("source\n")}\nsize 7\n`,
  );
  await f.git(["add", "--force", "--", f.input]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /Third-party input changed/u);
});

test("malformed inventory and absent metadata fail with useful diagnostics", async (t) => {
  const f = await fixture(t);
  await f.put("third-party/inventory.json", "{");
  await f.git(["add", "--", "third-party/inventory.json"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /Invalid release inventory JSON/u);
  f.manifest.schemaVersion = 2;
  await f.saveManifest();
  await f.git(["add", "--", "third-party/inventory.json"]);
  await assert.rejects(verifyReleaseInputs({ root: f.root }), /Invalid release inventory inputs/u);
  for (const file of [
    "third-party/inventory.json",
    "THIRD-PARTY-NOTICES.md",
    "third-party/release-review-baseline.json",
  ]) {
    await f.git(["reset", "--quiet", "HEAD"]);
    await f.git(["rm", "--cached", "--", file]);
    await assert.rejects(
      verifyReleaseInputs({ root: f.root }),
      (error) => error.message.includes("missing") && error.message.includes(file),
    );
  }
});

test("real committed CLI works without dependencies and rejects unsupported arguments", async (t) => {
  const f = await fixture(t);
  for (const file of ["scripts/verify-release-inputs.mjs", "scripts/third-party-notices.mjs"]) {
    await f.put(file, await readFile(resolve(import.meta.dirname, "..", file)));
  }
  await f.git(["add", "--", "scripts"]);
  await f.git(["commit", "--quiet", "-m", "real verifier"]);
  const run = (args) =>
    new Promise((done, reject) => {
      execFile(
        process.execPath,
        [join(f.root, "scripts/verify-release-inputs.mjs"), ...args],
        { cwd: f.root, env: { ...process.env, NODE_OPTIONS: "" } },
        (error, stdout, stderr) =>
          error ? reject(Object.assign(error, { stderr })) : done(stdout),
      );
    });
  assert.match(
    await run(["--source=HEAD"]),
    /Release Git HEAD: 1 inputs verified; 20 recorded material gaps retained/u,
  );
  for (const args of [["--source=bad"], ["--source"], ["--source=HEAD", "extra"]]) {
    await assert.rejects(run(args), (error) => error.code === 1 && error.stderr.includes("Usage:"));
  }
});

test("managed source material survives a user's global text ignore", async (t) => {
  const f = await fixture(t);
  const realRoot = resolve(import.meta.dirname, "..");
  await f.put(".gitignore", await readFile(join(realRoot, ".gitignore")));
  const files = [
    "third-party/upstream/new.txt",
    "third-party/runtime/new.txt",
    "third-party/mise/LICENSE.txt",
    "third-party/native-search/licenses/new.txt",
    "scripts/license-texts/new.txt",
  ];
  for (const file of files) await f.put(file, "source material\n");
  await f.git(["add", "--", ...files]);
  const staged = (await f.git(["diff", "--cached", "--name-only"])).stdout;
  for (const file of files) assert.ok(staged.includes(file), file);
  await f.put("node_modules/unwanted.txt", "cache");
  await assert.rejects(f.git(["add", "--", "node_modules/unwanted.txt"]));
});

test("local entrypoints distinguish staged validation from the commit being pushed", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  assert.equal(manifest.scripts["verify:release-inputs"], "node scripts/verify-release-inputs.mjs");
  const commands = manifest.scripts["verify:pre-push"].split(" && ");
  assert.equal(commands[0], "pnpm run verify:release-inputs --source=HEAD");
  assert.ok(commands.includes("pnpm run lint"));
  assert.ok(commands.includes("pnpm run architecture:check -- --changed"));
});
