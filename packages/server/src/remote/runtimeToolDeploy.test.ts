import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  getRemoteRuntimeToolsForPlatform,
  isRequiredRemoteResourcePackage,
  normalizeRemoteResourcePackageSelection,
} from "@lcode/shared";
import { REMOTE_BASE } from "./deployShared.js";
import { deployMiseRuntime, deployRuntimeTools } from "./runtimeToolDeploy.js";
import { LocalUploadAssetInstaller, RemoteDownloadAssetInstaller } from "./remoteAssetInstaller.js";
import {
  ensureRemoteReleaseDirFromCdn,
  parseRemoteAssetManifestFromResponse,
  usesRemoteAssetContentAddressedCacheIdentity,
} from "./remoteAssetCache.js";
import {
  createMiseDeployFixture,
  MISE_TEST_MEMBERS,
  miseTestLoggers,
} from "./remoteMiseDeploy.fixture.js";

for (const platformArch of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
  test(`local upload installs the whole mandatory mise component for ${platformArch}`, async (t) => {
    const fixture = await createMiseDeployFixture(t, platformArch);
    const { backend, releaseDir } = fixture;
    const installer = new LocalUploadAssetInstaller(
      backend,
      { releaseDir, platformArch },
      miseTestLoggers,
    );
    await deployRuntimeTools(
      backend,
      backend.environment,
      { platformArch, installer, selectedResourcePackageIds: [] },
      miseTestLoggers,
    );
    for (const member of MISE_TEST_MEMBERS) {
      assert.equal(
        await backend.readFile(`${REMOTE_BASE}/tools/mise/${member}`),
        await readFile(join(fixture.sourceDir, member), "utf8"),
      );
    }
    assert.equal(backend.uploads.length, 1);
    assert.ok(
      backend.commands.some(
        (command) => command.includes("chmod +x") && command.includes("tools/mise/bin/mise"),
      ),
    );
    const marker = JSON.parse(await backend.readFile(`${REMOTE_BASE}/.asset-components/mise.json`));
    assert.equal(marker.sha256, fixture.manifestRef.manifest.components[0]!.sha256);
    await deployMiseRuntime(
      backend,
      backend.environment,
      { platformArch, installer },
      miseTestLoggers,
    );
    assert.equal(backend.uploads.length, 1, "matching content is verified without another upload");
    await rm(backend.localPath(`${REMOTE_BASE}/tools/mise/LICENSE`));
    await deployMiseRuntime(
      backend,
      backend.environment,
      { platformArch, installer },
      miseTestLoggers,
    );
    assert.equal(
      backend.uploads.length,
      2,
      "missing license repairs a version-matching installation",
    );
  });
}

test("mise is a required component but is not an Agent runtime tool", () => {
  assert.ok(normalizeRemoteResourcePackageSelection({ selectedPackageIds: [] }).includes("mise"));
  assert.equal(isRequiredRemoteResourcePackage("mise"), true);
  for (const platform of ["linux", "darwin", "win32"]) {
    assert.ok(
      getRemoteRuntimeToolsForPlatform(platform).every(({ toolId }) => String(toolId) !== "mise"),
    );
  }
});

test("manifest recognizes mise's exact target mount and content-addressed cache", async (t) => {
  const fixture = await createMiseDeployFixture(t);
  const parsed = await parseRemoteAssetManifestFromResponse(
    Response.json(fixture.manifestRef.manifest),
    "https://fixture.invalid/manifest.json",
    "fixture-app",
    fixture.platformArch,
  );
  assert.equal(parsed.components[0]?.id, "mise");
  assert.equal(usesRemoteAssetContentAddressedCacheIdentity("mise"), true);
  fixture.manifestRef.manifest.components[0]!.mount = "tools/darwin-x64/mise";
  await assert.rejects(
    parseRemoteAssetManifestFromResponse(
      Response.json(fixture.manifestRef.manifest),
      "https://fixture.invalid/manifest.json",
      "fixture-app",
      fixture.platformArch,
    ),
    /mount mismatch/u,
  );
});

for (const missing of ["component", ...MISE_TEST_MEMBERS]) {
  test(`missing mandatory mise ${missing} fails closed before an upload`, async (t) => {
    const fixture = await createMiseDeployFixture(t);
    if (missing === "component") {
      fixture.manifestRef.manifest.components = [];
      await writeFile(
        join(fixture.releaseDir, `manifest-${fixture.platformArch}.json`),
        JSON.stringify(fixture.manifestRef.manifest),
      );
    } else {
      await rm(join(fixture.sourceDir, missing));
    }
    const installer = new LocalUploadAssetInstaller(fixture.backend, fixture, miseTestLoggers);
    await assert.rejects(
      deployMiseRuntime(
        fixture.backend,
        fixture.backend.environment,
        { ...fixture, installer },
        miseTestLoggers,
      ),
      /capability-unavailable.*mise/u,
    );
    assert.equal(fixture.backend.uploads.length, 0);
    assert.equal(fixture.backend.commands.length, 0);
  });
}

for (const invalid of ["binary", "version", "platform", "archiveSha256", "probe"]) {
  test(`mise ${invalid} verification rejects and never publishes a ready identity`, async (t) => {
    const fixture = await createMiseDeployFixture(t);
    if (invalid === "binary") await writeFile(join(fixture.sourceDir, "bin/mise"), "tampered");
    if (invalid === "version") fixture.manifest.version = "v0.0.1";
    if (invalid === "platform") fixture.manifest.platform = "macos-x64";
    if (invalid === "archiveSha256") fixture.manifest.archiveSha256 = "not-a-digest";
    if (invalid === "probe") {
      const binary = "#!/bin/sh\nprintf '%s\\n' '0.0.1 linux-x64'\n";
      await writeFile(join(fixture.sourceDir, "bin/mise"), binary);
      fixture.manifest.binarySha256 = createHash("sha256").update(binary).digest("hex");
    }
    await writeFile(
      join(fixture.sourceDir, "backend-manifest.json"),
      JSON.stringify(fixture.manifest),
    );
    const installer = new LocalUploadAssetInstaller(fixture.backend, fixture, miseTestLoggers);
    await assert.rejects(
      deployMiseRuntime(
        fixture.backend,
        fixture.backend.environment,
        { ...fixture, installer },
        miseTestLoggers,
      ),
      /capability-unavailable.*mise/u,
    );
    assert.equal(await fixture.backend.exists(`${REMOTE_BASE}/.asset-components/mise.json`), false);
    assert.ok(
      fixture.backend.commands.every(
        (command) =>
          !/command -v mise|which mise|mise install|curl.*mise|wget.*mise/u.test(command),
      ),
    );
  });
}

test("remote-download reuses the exact mise component and preserves its full directory", async (t) => {
  const fixture = await createMiseDeployFixture(t, "darwin-arm64");
  const component = fixture.manifestRef.manifest.components[0]!;
  const componentDir = `${REMOTE_BASE}/asset-cache/components/${fixture.platformArch}/mise/${component.sha256}`;
  await mkdir(fixture.backend.localPath(componentDir), { recursive: true });
  await cp(fixture.sourceDir, fixture.backend.localPath(componentDir), { recursive: true });
  await writeFile(fixture.backend.localPath(`${componentDir}/.ready`), "ready");
  const installer = new RemoteDownloadAssetInstaller(
    fixture.backend,
    {
      version: "fixture-app",
      platformArch: fixture.platformArch,
      remoteAssetNetwork: {
        fetch: async () => {
          throw new Error("fixture forbids network");
        },
      },
    },
    { download: "curl", sha256: "sha256sum", tar: "tar" },
    miseTestLoggers,
    Promise.resolve(fixture.manifestRef),
  );
  await deployMiseRuntime(
    fixture.backend,
    fixture.backend.environment,
    { ...fixture, installer },
    miseTestLoggers,
  );
  assert.equal(fixture.backend.uploads.length, 0);
  for (const member of MISE_TEST_MEMBERS)
    assert.equal(await fixture.backend.exists(`${REMOTE_BASE}/tools/mise/${member}`), true);
  assert.ok(
    fixture.backend.commands.some(
      (command) => command.includes("cp -R") && command.includes(component.sha256),
    ),
  );
});

test("a release tar root is verified, materialized and deployed without an extra mise directory", async (t) => {
  const fixture = await createMiseDeployFixture(t);
  const archive = await readFile(fixture.archivePath);
  const component = fixture.manifestRef.manifest.components[0]!;
  const requests: string[] = [];
  const releaseDir = await ensureRemoteReleaseDirFromCdn(
    {
      version: "fixture-app",
      platformArch: fixture.platformArch,
      remoteCdnBaseUrl: "https://fixture.invalid",
      remoteCacheDir: join(fixture.root, "cache"),
      componentIds: ["mise"],
      manifestRef: fixture.manifestRef,
      requiredReleasePaths: MISE_TEST_MEMBERS.map(
        (member) => `${fixture.sourceRelativePath}/${member}`,
      ),
      remoteAssetNetwork: {
        fetch: async (url) => {
          requests.push(String(url));
          assert.ok(decodeURIComponent(String(url)).endsWith(component.artifactPath));
          return new Response(archive, { headers: { "content-length": String(archive.length) } });
        },
      },
    },
    miseTestLoggers,
  );
  const installer = new LocalUploadAssetInstaller(
    fixture.backend,
    { releaseDir, platformArch: fixture.platformArch },
    miseTestLoggers,
  );
  await deployMiseRuntime(
    fixture.backend,
    fixture.backend.environment,
    { ...fixture, installer },
    miseTestLoggers,
  );
  assert.equal(requests.length, 1);
  assert.equal(await fixture.backend.exists(`${REMOTE_BASE}/tools/mise/bin/mise`), true);
  assert.equal(await fixture.backend.exists(`${REMOTE_BASE}/tools/mise/mise`), false);
});

test("a release tar with the wrong SHA cannot be materialized as mise", async (t) => {
  const fixture = await createMiseDeployFixture(t);
  await assert.rejects(
    ensureRemoteReleaseDirFromCdn(
      {
        version: "fixture-app",
        platformArch: fixture.platformArch,
        remoteCdnBaseUrl: "https://fixture.invalid",
        remoteCacheDir: join(fixture.root, "cache"),
        componentIds: ["mise"],
        manifestRef: fixture.manifestRef,
        remoteAssetNetwork: { fetch: async () => new Response("corrupt archive") },
      },
      miseTestLoggers,
    ),
    /sha256 mismatch/u,
  );
  assert.equal(fixture.backend.uploads.length, 0);
});

test("native Windows targets fail capability checking without touching a backend", async (t) => {
  const fixture = await createMiseDeployFixture(t);
  const installer = new LocalUploadAssetInstaller(fixture.backend, fixture, miseTestLoggers);
  await assert.rejects(
    deployMiseRuntime(
      fixture.backend,
      { platform: "win32", arch: "x64" },
      { ...fixture, installer },
      miseTestLoggers,
    ),
    /capability-unavailable.*mise/u,
  );
  assert.equal(fixture.backend.commands.length, 0);
  assert.equal(fixture.backend.uploads.length, 0);
});

test("a removed executable mode is restored when a verified mise identity is reused", async (t) => {
  const fixture = await createMiseDeployFixture(t);
  const installer = new LocalUploadAssetInstaller(fixture.backend, fixture, miseTestLoggers);
  await deployMiseRuntime(
    fixture.backend,
    fixture.backend.environment,
    { ...fixture, installer },
    miseTestLoggers,
  );
  await chmod(fixture.backend.localPath(`${REMOTE_BASE}/tools/mise/bin/mise`), 0o644);
  await deployMiseRuntime(
    fixture.backend,
    fixture.backend.environment,
    { ...fixture, installer },
    miseTestLoggers,
  );
  assert.equal(fixture.backend.uploads.length, 1);
});
