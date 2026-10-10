import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";
import { stageKoffiIntoBundledAgents, verifyStagedKoffi } from "./koffi-package-assets.mjs";
import { stageAgentBundle } from "./stage-agent-bundle.mjs";

const exec = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../..");
const adapterRoot = join(repoRoot, "apps/lcode-cli/packages/adapters");
const targets = [
  "win32-x64",
  "win32-arm64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
];
const packageFiles = ["index.js", "package.json", "index.d.ts", "LICENSE.txt"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lcode-agent-koffi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source-koffi");
  const glmDir = join(root, "resources/glm");
  await mkdir(sourceRoot, { recursive: true });
  for (const file of packageFiles) {
    await writeFile(
      join(sourceRoot, file),
      file === "package.json" ? '{"name":"koffi"}' : "fixture",
    );
  }
  for (const target of targets) {
    const nativeDir = join(sourceRoot, "build/koffi", target.replace("-", "_"));
    await mkdir(nativeDir, { recursive: true });
    await writeFile(join(nativeDir, "koffi.node"), target);
  }
  return { root, sourceRoot, glmDir };
}

for (const target of targets) {
  test(`Agent stages only the ${target} Koffi addon and validates the resource root`, async (t) => {
    const { root, sourceRoot, glmDir } = await fixture(t);
    const [os, arch] = target.split("-");
    const targetPlatform = { os, arch };
    const stale = join(glmDir, "node_modules/koffi/build/koffi/stale");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "koffi.node"), "stale");
    await stageKoffiIntoBundledAgents({ koffiPackageRoot: sourceRoot, glmDir, targetPlatform });
    assert.deepEqual(await readdir(join(glmDir, "node_modules/koffi/build/koffi")), [
      `${os}_${arch}`,
    ]);
    for (const file of packageFiles) {
      assert.deepEqual(
        await readFile(join(glmDir, "node_modules/koffi", file)),
        await readFile(join(sourceRoot, file)),
      );
    }
    assert.deepEqual(
      await verifyStagedKoffi({ resourcesDir: join(root, "resources"), targetPlatform }),
      [],
    );
  });
}

test("missing source addon rejects staging before publishing a package", async (t) => {
  const { sourceRoot, glmDir } = await fixture(t);
  await rm(join(sourceRoot, "build/koffi/win32_x64/koffi.node"));
  await assert.rejects(
    stageKoffiIntoBundledAgents({
      koffiPackageRoot: sourceRoot,
      glmDir,
      targetPlatform: { os: "win32", arch: "x64" },
    }),
    /missing target native addon/,
  );
});

test("packaged Agent validation rejects a stale platform addon", async (t) => {
  const { root, sourceRoot, glmDir } = await fixture(t);
  const targetPlatform = { os: "win32", arch: "x64" };
  await stageKoffiIntoBundledAgents({ koffiPackageRoot: sourceRoot, glmDir, targetPlatform });
  await mkdir(join(glmDir, "node_modules/koffi/build/koffi/darwin_arm64"));
  assert.match(
    (await verifyStagedKoffi({ resourcesDir: join(root, "resources"), targetPlatform })).join("\n"),
    /unexpected Agent koffi platform: darwin_arm64/,
  );
});

for (const file of [...packageFiles, "build/koffi/win32_x64/koffi.node"]) {
  test(`packaged Agent validation rejects missing ${file}`, async (t) => {
    const { root, sourceRoot, glmDir } = await fixture(t);
    const targetPlatform = { os: "win32", arch: "x64" };
    await stageKoffiIntoBundledAgents({ koffiPackageRoot: sourceRoot, glmDir, targetPlatform });
    await rm(join(glmDir, "node_modules/koffi", file));
    assert.ok(
      (await verifyStagedKoffi({ resourcesDir: join(root, "resources"), targetPlatform })).length >
        0,
    );
  });
}

async function prepareRepoFixture(root) {
  for (const plugin of ["lemon-workflow-plugin", "lcode-cua-plugin"]) {
    await cp(
      join(repoRoot, "apps/lcode-cli/packages", plugin),
      join(root, "apps/lcode-cli/packages", plugin),
      { recursive: true },
    );
  }
  const bundle = join(root, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
  await mkdir(dirname(bundle), { recursive: true });
  return bundle;
}

test("shared staging does not publish success meta when the native source is missing", async (t) => {
  const { root, sourceRoot } = await fixture(t);
  const bundle = await prepareRepoFixture(root);
  await writeFile(bundle, "// fixture bundle\n");
  await rm(join(sourceRoot, "build/koffi/win32_x64/koffi.node"));
  await assert.rejects(
    stageAgentBundle({
      repoRoot: root,
      platformKey: "win32-x64",
      koffiPackageRoot: sourceRoot,
      log: () => {},
    }),
    /missing target native addon/,
  );
  await assert.rejects(
    readFile(join(root, "packages/desktop/bundled-agents/win32-x64/glm/.node-bundle-meta.json")),
    { code: "ENOENT" },
  );
});

test(
  "electron-builder resources run consecutive real Bash executions outside workspace dependencies",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-agent-bash-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bundle = await prepareRepoFixture(root);
    const adapterEntry = join(adapterRoot, "src/exec/node-execution-adapter.ts");
    await build({
      stdin: {
        contents: `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NodeExecutionAdapter } from ${JSON.stringify(adapterEntry)};
(async () => {
  const adapter = new NodeExecutionAdapter({ outputRootDir: join(process.cwd(), 'output') });
  try {
    for (let i = 0; i < 3; i++) {
      const result = await adapter.run({ command: { mode: 'shell', shellProfile: 'posix-bash', command: 'echo packaged-bash-ok' }, cwd: process.cwd() });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.stdout.text, /packaged-bash-ok/);
    }
    process.stdout.write('three-owned-bash-executions-ok');
  } finally { await adapter.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });`,
        resolveDir: repoRoot,
        loader: "ts",
      },
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["koffi"],
      logLevel: "silent",
    });
    const { stagedBundlePath } = await stageAgentBundle({
      repoRoot: root,
      platformKey: `${process.platform}-${process.arch}`,
      koffiPackageRoot: adapterRoot,
      log: () => {},
    });
    const { default: config } = await import("../electron-builder.config.js");
    const requireFromDesktop = createRequire(new URL("../package.json", import.meta.url));
    const requireFromBuilder = createRequire(
      requireFromDesktop.resolve("electron-builder/package.json"),
    );
    const { FileMatcher, copyFiles } = requireFromBuilder("app-builder-lib/out/fileMatcher.js");
    const resourcesDir = join(root, "packaged/resources");
    // 必须经过构建器的真实复制边界；直接运行 staging 会漏测根 node_modules 被过滤的问题。
    const agentResources = config.extraResources.filter(
      (entry) => entry.to === "glm" || entry.to.startsWith("glm/"),
    );
    await copyFiles(
      agentResources.map(
        (entry) =>
          new FileMatcher(
            resolve(root, "packages/desktop", entry.from),
            resolve(resourcesDir, entry.to),
            (value) => value,
            entry.filter,
          ),
      ),
      undefined,
      false,
    );
    const packagedBundlePath = join(resourcesDir, "glm/lcode.cjs");
    assert.notEqual(packagedBundlePath, stagedBundlePath);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_PATH;
    const electron = createRequire(new URL("../package.json", import.meta.url))("electron");
    for (const runtime of [process.execPath, electron]) {
      const { stdout } = await exec(runtime, [packagedBundlePath], {
        cwd: root,
        env,
        windowsHide: true,
        timeout: 10000,
      });
      assert.match(stdout, /three-owned-bash-executions-ok/);
    }
    assert.deepEqual(
      await verifyStagedKoffi({
        resourcesDir,
        targetPlatform: { os: process.platform, arch: process.arch },
      }),
      [],
    );
  },
);
