import assert from "node:assert/strict";
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createRuntimePackageCacheCleaner } from "./adapters/packageCache.js";
import { withPackageStoreLease } from "./adapters/packageStoreLease.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createDependencyInstaller } from "./adapters/dependencyInstall.js";
import type { BackendCommandResult } from "./adapters/backendCommand.js";
import { backendPlatformKey, detectBackendPlatform } from "./adapters/backendPlatform.js";

async function fixture(t: { after(action: () => Promise<unknown>): void }, real = false) {
  const root = await mkdtemp(join(tmpdir(), "lcode-pnpm-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, "v2/runtime-environments");
  const store = join(runtime, "package-store/pnpm");
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const os = platform as "windows" | "macos" | "linux";
  const platformRoot = join(
    runtime,
    "tool-store/mise/v2026.10.2",
    backendPlatformKey(detectBackendPlatform()),
  );
  const node = join(
    platformRoot,
    "data/installs/node/24.21.0",
    process.platform === "win32" ? "node.exe" : "bin/node",
  );
  const pnpm = join(platformRoot, "data/installs/pnpm/10.34.6/bin/pnpm.cjs");
  for (const path of [
    node,
    pnpm,
    join(store, "v10/files/cache"),
    join(root, "project/node_modules/keep"),
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "keep");
  }
  if (real) {
    await unlink(node);
    await link(process.execPath, node).catch(() => copyFile(process.execPath, node));
    await writeFile(
      pnpm,
      `const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);const store=args[args.indexOf('--store-dir')+1];
if(args.at(-1)==='path')process.stdout.write(path.join(store,'v10'));
else {if(process.cwd()!==store)process.exit(2);if(args.includes('--force'))process.exit(3);fs.unlinkSync(path.join(store,'v10/files/cache'));}
`,
    );
  }
  await createRuntimeEnvironmentStore(runtime).saveManifest("a".repeat(32), 1, {
    schemaVersion: 1,
    backendVersion: "v2026.10.2",
    os,
    arch: process.arch as "x64" | "arm64",
    tools: [
      {
        key: "node",
        version: "24.21.0",
        toolPath: node,
        source: "app-default",
        installStrategy: "managed-tool-store",
      },
      {
        key: "pnpm",
        version: "10.34.6",
        toolPath: pnpm,
        source: "app-default",
        installStrategy: "managed-tool-store",
      },
    ],
    declarationDigest: "test",
    manifestDigest: "test",
    installStrategy: "frozen",
    createdAt: new Date().toISOString(),
  });
  return { root, runtime, store, node, pnpm };
}

test("real child process uses a fixed store and preserves tools and project dependencies", async (t) => {
  const f = await fixture(t, true);
  const result = await createRuntimePackageCacheCleaner().clean(f.root);
  assert.equal(result.freedBytes, 4);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(result.failures, []);
  for (const path of [f.node, f.pnpm, join(f.root, "project/node_modules/keep")])
    await access(path);
  assert.equal((await createRuntimePackageCacheCleaner().clean(f.root)).deletedCount, 0);
});

test("empty cache is a no-op without tools and a thrown command still accounts for removed files", async (t) => {
  const f = await fixture(t);
  await unlink(join(f.store, "v10/files/cache"));
  await unlink(f.pnpm);
  assert.deepEqual(await createRuntimePackageCacheCleaner().clean(f.root), {
    freedBytes: 0,
    deletedCount: 0,
    skippedCount: 0,
    failures: [],
  });
  await writeFile(f.pnpm, "keep");
  await writeFile(join(f.store, "v10/files/cache"), "keep");
  const result = await createRuntimePackageCacheCleaner({
    runCommand: async (_executable, args) => {
      if (args.at(-1) === "path") return { code: 0, stdout: join(f.store, "v10"), stderr: "" };
      await unlink(join(f.store, "v10/files/cache"));
      throw new Error("terminated command");
    },
  }).clean(f.root);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.freedBytes, 4);
  assert.equal(result.failures[0]?.code, "EPNPMPRUNE");
});

test("multiple managed installers share the store while prune requires an exclusive lease", async (t) => {
  const f = await fixture(t);
  await withPackageStoreLease(
    f.store,
    async () => {
      await withPackageStoreLease(
        f.store,
        async () => {
          assert.equal(
            (await createRuntimePackageCacheCleaner().clean(f.root)).failures[0]?.code,
            "EBUSY",
          );
        },
        { shared: true },
      );
    },
    { shared: true },
  );
  await withPackageStoreLease(f.store, async () => {});
});

test("prune cannot enter while an actual managed command is running", async (t) => {
  const f = await fixture(t);
  const script = join(f.root, "held.cjs");
  const marker = join(f.root, "finish");
  await writeFile(
    script,
    `const fs=require('node:fs');const watcher=fs.watch(${JSON.stringify(f.root)},()=>{if(fs.existsSync(${JSON.stringify(marker)})){watcher.close();process.exit(0)}});process.stdout.write('ready');`,
  );
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const execution = createDependencyInstaller().runApprovedCommand({
    executable: process.execPath,
    args: [script],
    cwd: f.root,
    toolPaths: { node: process.execPath },
    env: { npm_config_store_dir: f.store },
    onOutput: async (output) => {
      if (output.includes("ready")) ready();
    },
  });
  await started;
  try {
    assert.equal(
      (await createRuntimePackageCacheCleaner().clean(f.root)).failures[0]?.code,
      "EBUSY",
    );
  } finally {
    await writeFile(marker, "finish");
  }
  assert.equal((await execution).exitCode, 0);
  await withPackageStoreLease(f.store, async () => {});
});

test("prune command is isolated, measures partial failures, and never forwards raw output", async (t) => {
  const f = await fixture(t);
  const commands: { args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv }[] = [];
  const result = await createRuntimePackageCacheCleaner({
    runCommand: async (_executable, args, env, options): Promise<BackendCommandResult> => {
      commands.push({ args, cwd: options.cwd, env });
      if (args.at(-1) === "path") return { code: 0, stdout: join(f.store, "v10"), stderr: "" };
      await unlink(join(f.store, "v10/files/cache"));
      return { code: 1, stdout: "untrusted output", stderr: "untrusted failure" };
    },
  }).clean(f.root);
  assert.equal(result.freedBytes, 4);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.failures[0]?.code, "EPNPMPRUNE");
  assert.equal(JSON.stringify(result).includes("untrusted"), false);
  assert.equal(commands.length, 2);
  assert.equal(commands[1]?.cwd, f.store);
  assert.equal(commands[1]?.args.includes("--force"), false);
  assert.ok(commands[1]?.args.includes(`--config.cache-dir=${join(f.store, "metadata-cache")}`));
  assert.ok(commands[1]?.args.includes("--config.manage-package-manager-versions=false"));
});

test("foreign store path, missing tools and a busy store cannot fall back to deletion", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const cleaner = createRuntimePackageCacheCleaner({
    runCommand: async () => {
      calls++;
      return { code: 0, stdout: join(f.root, "project"), stderr: "" };
    },
  });
  assert.equal((await cleaner.clean(f.root)).failures[0]?.code, "EUNSAFEPATH");
  assert.equal(calls, 1);
  await withPackageStoreLease(f.store, async () => {
    assert.equal((await cleaner.clean(f.root)).failures[0]?.code, "EBUSY");
  });
  assert.equal(calls, 1);
  await unlink(f.pnpm);
  assert.equal((await cleaner.clean(f.root)).failures[0]?.code, "ETOOLUNAVAILABLE");
  assert.equal(await readFile(join(f.store, "v10/files/cache"), "utf8"), "keep");
});

test("redirected package stores are rejected before any command starts", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await rm(f.store, { recursive: true });
  try {
    await symlink(outside, f.store, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("symlink permission unavailable");
    return;
  }
  let called = false;
  const result = await createRuntimePackageCacheCleaner({
    runCommand: async () => {
      called = true;
      throw new Error("unexpected");
    },
  }).clean(f.root);
  assert.equal(called, false);
  assert.equal(result.failures[0]?.code, "EUNSAFEPATH");
});

test("managed dependency commands share the prune lease and retain it until process settlement", async (t) => {
  const f = await fixture(t, true);
  const script = join(f.root, "process.cjs");
  await writeFile(script, "process.stdout.write('ok')");
  const installer = createDependencyInstaller();
  await withPackageStoreLease(f.store, async () => {
    await assert.rejects(
      installer.runApprovedCommand({
        executable: process.execPath,
        args: [script],
        cwd: f.root,
        toolPaths: { node: process.execPath },
        env: { npm_config_store_dir: f.store },
      }),
      /lock|busy/i,
    );
  });
  const result = await installer.runApprovedCommand({
    executable: process.execPath,
    args: [script],
    cwd: f.root,
    toolPaths: { node: process.execPath },
    env: { npm_config_store_dir: f.store },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "ok");
});
