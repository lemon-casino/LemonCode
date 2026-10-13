import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { bundleRemoteAssetsEnabled, prepareBundledRemoteAssets } from "./bundled-remote-assets.mjs";
import { createRemoteReleaseFixture } from "./remote-release-assets.fixture.mjs";

test("local bundles default to platform-specific CDN downloads and embedding is explicit", async () => {
  assert.equal(bundleRemoteAssetsEnabled({}), false);
  assert.equal(bundleRemoteAssetsEnabled({ LCODE_BUNDLE_REMOTE_ASSETS: "0" }), false);
  assert.equal(bundleRemoteAssetsEnabled({ LCODE_BUNDLE_REMOTE_ASSETS: "1" }), true);
  assert.throws(
    () => bundleRemoteAssetsEnabled({ LCODE_BUNDLE_REMOTE_ASSETS: "wrong" }),
    /invalid/i,
  );
  const workflow = YAML.parse(
    await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.jobs.build.env.LCODE_BUNDLE_REMOTE_ASSETS, "0");
});

test("ordinary bundle plans and builder resources exclude remote archives; explicit embedding preserves them", async () => {
  const run = promisify(execFile);
  const configUrl = new URL("../packages/desktop/electron-builder.config.js", import.meta.url).href;
  const bundlePath = fileURLToPath(
    new URL("../packages/desktop/scripts/bundle.mjs", import.meta.url),
  );
  for (const mode of [undefined, "0", "1"]) {
    const env = {
      ...process.env,
      LCODE_ENV: "production",
      LCODE_TARGET_OS: "win",
      LCODE_TARGET_ARCH: "x64",
    };
    if (mode === undefined) delete env.LCODE_BUNDLE_REMOTE_ASSETS;
    else env.LCODE_BUNDLE_REMOTE_ASSETS = mode;
    const result = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {default: config}=await import(${JSON.stringify(configUrl)});process.stdout.write(JSON.stringify(config.extraResources.filter((entry)=>entry.to==='remote-assets')));`,
      ],
      { env, windowsHide: true },
    );
    const resources = JSON.parse(result.stdout);
    assert.equal(resources.length, mode === "1" ? 1 : 0);
    const plan = await run(
      process.execPath,
      [bundlePath, "--os", "win", "--arch", "x64", "--dry-run"],
      { env, windowsHide: true },
    );
    assert.ok(plan.stdout.includes(`remote-assets=${mode === "1" ? "bundled" : "on-demand"}`));
  }
});

test("the bundle size gate keeps the base limit while accounting for explicitly included runtime bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-remote-size-"));
  try {
    const path = join(root, "fixture.exe");
    const file = await open(path, "w");
    await file.truncate(501 * 1024 * 1024);
    await file.close();
    const run = promisify(execFile);
    const args = [
      fileURLToPath(new URL("../packages/desktop/scripts/audit-bundle-size.mjs", import.meta.url)),
      "--artifact-path",
      path,
    ];
    await assert.rejects(run(process.execPath, args, { windowsHide: true }), /exceeds/i);
    await run(process.execPath, [...args, "--additional-runtime-bytes", String(2 * 1024 * 1024)], {
      windowsHide: true,
    });
    await assert.rejects(
      run(process.execPath, [...args, "--additional-runtime-bytes", "NaN"], { windowsHide: true }),
      /invalid/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unpublished local assets use the existing producer and skip only verifies existing staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-local-bundle-"));
  try {
    const fixture = await createRemoteReleaseFixture(root);
    const outputDir = join(root, "staged");
    const calls = [];
    const options = {
      ...fixture,
      outputDir,
      repoRoot: root,
      run: async (...args) => calls.push(args),
    };
    await prepareBundledRemoteAssets(options);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ["prepare:remote-assets"]);
    await prepareBundledRemoteAssets({ ...options, skipPrepare: true });
    assert.equal(calls.length, 1);
    await rm(join(outputDir, "manifest-linux-x64.json"));
    await assert.rejects(
      prepareBundledRemoteAssets({ ...options, skipPrepare: true }),
      /manifest/i,
    );
    const failedRoot = join(root, "failed");
    await assert.rejects(
      prepareBundledRemoteAssets({
        ...options,
        outputDir: failedRoot,
        run: async () => {
          throw new Error("producer failed");
        },
      }),
      /producer failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
