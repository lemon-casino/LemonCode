import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { miseFixture, digest } from "./mise-runtime-test-fixtures.mjs";
import {
  prepareRemoteMiseRuntimeAssets,
  resolveRemoteMiseTarget,
  stageServerMiseRuntimeAssets,
} from "./prepare-remote-mise-assets.mjs";
import { resolveMiseTarget } from "../packages/desktop/scripts/prepare-mise-runtime-assets.mjs";
import {
  buildRemoteComponentDefinitions,
  prepareRemoteComponentArtifact,
} from "./prepare-prebuilds.mjs";

function tarFiles(bytes) {
  const tar = gunzipSync(bytes);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0; ) {
    const text = (start, length) =>
      tar
        .subarray(offset + start, offset + start + length)
        .toString("utf8")
        .split("\0", 1)[0]
        .trim();
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    const size = parseInt(text(124, 12) || "0", 8);
    const mode = parseInt(text(100, 8) || "0", 8);
    entries.set(name, { bytes: tar.subarray(offset + 512, offset + 512 + size), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("production remote component definitions include fixed mise for every remote target", () => {
  for (const platformKey of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    const component = buildRemoteComponentDefinitions(platformKey).find(
      (entry) => entry.id === "mise",
    );
    assert.ok(component, platformKey);
    assert.equal(component.semanticPrefix, "v2026.10.2");
    assert.equal(component.mount, `tools/${platformKey}/mise`);
    assert.ok(component.sourcePath.replaceAll("\\", "/").endsWith(`tools/${platformKey}/mise`));
    assert.equal(resolveRemoteMiseTarget(platformKey).os, platformKey.split("-")[0]);
  }
});

test("the actual remote component packer includes mise binary, license and verified manifest", async (t) => {
  const fixture = await miseFixture(t);
  const platformKey = "linux-arm64";
  const options = {
    outputDir: join(fixture.root, "release", "tools"),
    desktopRoot: fixture.root,
    platformKey,
    cacheDir: fixture.cacheDir,
    backendApi: fixture.api,
  };
  const prepared = await prepareRemoteMiseRuntimeAssets(options);
  const component = {
    ...buildRemoteComponentDefinitions(platformKey).find((entry) => entry.id === "mise"),
    sourcePath: prepared.root,
  };
  const entry = await prepareRemoteComponentArtifact({
    mockCdnDir: fixture.root,
    platformKey,
    component,
    cacheDir: fixture.cacheDir,
    backendApi: fixture.api,
  });
  const archive = await readFile(join(fixture.root, entry.artifactPath));
  assert.equal(entry.sha256, digest(archive));
  assert.equal(entry.mount, `tools/${platformKey}/mise`);
  const files = tarFiles(archive);
  for (const name of ["bin/mise", "LICENSE", "README.md", "backend-manifest.json"])
    assert.ok(files.has(name), name);
  const manifest = JSON.parse(files.get("backend-manifest.json").bytes);
  assert.equal(manifest.platform, "linux-arm64");
  assert.equal(manifest.archiveSha256, fixture.api.MISE_ASSET_DIGESTS["linux-arm64"]);
  assert.equal(manifest.binarySha256, digest(files.get("bin/mise").bytes));
  assert.ok(files.get("bin/mise").mode & 0o111);
  const reused = await prepareRemoteComponentArtifact({
    mockCdnDir: fixture.root,
    platformKey,
    component,
    previousComponents: new Map([["mise", entry]]),
    cacheDir: fixture.cacheDir,
    backendApi: fixture.api,
  });
  assert.deepEqual(reused, entry);
  await writeFile(join(prepared.root, "bin", "mise"), "broken input\n");
  await assert.rejects(
    prepareRemoteComponentArtifact({
      mockCdnDir: fixture.root,
      platformKey,
      component,
      previousComponents: new Map([["mise", entry]]),
      cacheDir: fixture.cacheDir,
      backendApi: fixture.api,
    }),
    /binary digest|provenance/u,
  );
});

test("remote skip is read-only and refuses old runtime trees without mise", async (t) => {
  const fixture = await miseFixture(t);
  const options = {
    outputDir: join(fixture.root, "release", "tools"),
    desktopRoot: fixture.root,
    platformKey: "darwin-x64",
    cacheDir: fixture.cacheDir,
    backendApi: fixture.api,
  };
  await mkdir(join(options.outputDir, options.platformKey, "ripgrep"), { recursive: true });
  await assert.rejects(
    prepareRemoteMiseRuntimeAssets({ ...options, skip: true }),
    /missing|ENOENT/u,
  );
  assert.equal(fixture.calls.publish, 0);
  const prepared = await prepareRemoteMiseRuntimeAssets(options);
  const calls = fixture.calls.publish;
  await prepareRemoteMiseRuntimeAssets({ ...options, skip: true });
  assert.equal(fixture.calls.publish, calls);
  await rm(join(prepared.root, "backend-manifest.json"));
  await assert.rejects(prepareRemoteMiseRuntimeAssets({ ...options, skip: true }), /manifest/u);
  assert.equal(fixture.calls.publish, calls);
});

test("standalone server stages tools/mise for its target and skip cannot repair missing assets", async (t) => {
  const fixture = await miseFixture(t);
  const target = resolveMiseTarget({ os: "win32", arch: "x64", libc: "" });
  const options = {
    runtimeRoot: join(fixture.root, "server"),
    desktopRoot: fixture.root,
    target,
    cacheDir: fixture.cacheDir,
    backendApi: fixture.api,
  };
  await assert.rejects(stageServerMiseRuntimeAssets({ ...options, skip: true }), /ENOENT/u);
  const prepared = await stageServerMiseRuntimeAssets(options);
  assert.equal(prepared.root, join(options.runtimeRoot, "tools", "mise"));
  await readFile(join(prepared.root, "bin", "mise-shim.exe"));
  const calls = fixture.calls.publish;
  await stageServerMiseRuntimeAssets({ ...options, skip: true });
  await rm(join(prepared.root, "LICENSE"));
  await assert.rejects(stageServerMiseRuntimeAssets({ ...options, skip: true }), /ENOENT/u);
  assert.equal(fixture.calls.publish, calls);
});

test("standalone remote build and prebuild publish use the same mise preparation contract", async () => {
  const prebuild = await readFile(new URL("./prepare-prebuilds.mjs", import.meta.url), "utf8");
  assert.match(prebuild, /await prepareRemoteMiseRuntimeAssets\(/u);
  assert.match(prebuild, /await prepareRemoteComponentArtifacts\(/u);
  const remoteBuild = await readFile(
    new URL("../packages/server/build-remote.ts", import.meta.url),
    "utf8",
  );
  assert.match(remoteBuild, /stageServerMiseRuntimeAssets/u);
  const httpBuild = await readFile(
    new URL("../packages/server/tsup.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(httpBuild, /onSuccess:[\s\S]*stageServerMiseRuntimeAssets/u);
});
