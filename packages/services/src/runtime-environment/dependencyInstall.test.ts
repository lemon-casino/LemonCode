import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { createDependencyInstaller } from "./adapters/dependencyInstall.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lcode-依赖 空格-"));
  const pnpm = join(root, "pnpm.cjs");
  await writeFile(
    pnpm,
    `if(process.argv.includes('--version')) { process.stdout.write('10.33.2\\n'); }
else { const fs=require('node:fs'); fs.writeFileSync('receipt.json',JSON.stringify({args:process.argv.slice(2),node:process.execPath,path:process.env.PATH||process.env.Path,cache:process.env.npm_config_cache,importMethod:process.env.npm_config_package_import_method})); }
`,
  );
  return {
    root,
    paths: { node: process.execPath, pnpm },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("dependency execution uses frozen Node for JavaScript manager and exact frozen arguments", async () => {
  const f = await fixture();
  try {
    const installer = createDependencyInstaller();
    const hostPath = process.env.PATH;
    const result = await installer.install({
      cwd: f.root,
      command: "pnpm install --frozen-lockfile",
      manager: "pnpm",
      managerVersion: "10.33.2",
      toolPaths: f.paths,
      env: {
        npm_config_cache: join(f.root, "cache"),
        npm_config_package_import_method: "clone-or-copy",
        TEMP: join(f.root, "tmp"),
      },
    });
    assert.equal(result.exitCode, 0);
    const receipt = JSON.parse(await readFile(join(f.root, "receipt.json"), "utf8"));
    assert.equal(receipt.node, process.execPath);
    assert.deepEqual(receipt.args, [
      "install",
      "--frozen-lockfile",
      "--package-import-method=clone-or-copy",
    ]);
    assert.ok(receipt.path.toLowerCase().startsWith(dirname(process.execPath).toLowerCase()));
    assert.equal(receipt.importMethod, "clone-or-copy");
    assert.equal(process.env.PATH, hostPath);
  } finally {
    await f.close();
  }
});
test("manager mismatches and unapproved shell commands fail before installing", async () => {
  const f = await fixture();
  try {
    const installer = createDependencyInstaller();
    await assert.rejects(
      installer.install({
        cwd: f.root,
        command: "pnpm install --frozen-lockfile",
        manager: "pnpm",
        managerVersion: "9.0.0",
        toolPaths: f.paths,
        env: {},
      }),
      /version/,
    );
    await assert.rejects(
      installer.install({
        cwd: f.root,
        command: "pnpm install && unexpected",
        manager: "pnpm",
        toolPaths: f.paths,
        env: {},
      }),
      /unsupported/,
    );
  } finally {
    await f.close();
  }
});
test("npm resolves from frozen Node rather than a PATH shim", async () => {
  const installer = createDependencyInstaller();
  const actual = await installer.verifyManager!({
    manager: "npm",
    toolPaths: { node: process.execPath },
  });
  assert.match(actual.version, /^\d+\.\d+\.\d+/);
  assert.ok(actual.toolPath.includes("npm-cli.js"));
  assert.ok(
    actual.toolPath
      .toLowerCase()
      .startsWith(
        resolve(dirname(process.execPath), process.platform === "win32" ? "." : "..").toLowerCase(),
      ),
  );
});
test("a cancelled install does not create successful output", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "cwd"));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createDependencyInstaller().install({
        cwd: f.root,
        command: "pnpm install --frozen-lockfile",
        manager: "pnpm",
        toolPaths: f.paths,
        env: {},
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    await f.close();
  }
});
