import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createRemoteReleaseFixture } from "./remote-release-assets.fixture.mjs";
import { stageRemoteReleaseAssets } from "./stage-remote-release-assets.mjs";
import { buildRemoteComponentRequiredPaths } from "./prepare-prebuilds.mjs";

// 根脚本不声明 server 依赖，测试从目标包公开入口解析，避免依赖开发机 hoist。
const serverRequire = createRequire(new URL("../packages/server/package.json", import.meta.url));
const { ensureRemoteReleaseDirFromCdn, fetchRemoteAssetManifestRefFromCdn } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/remoteAssetCache.js")).href
);

test("fixed-tag redirect downloads manifest and every Linux x64 component into the real runtime cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-remote-download-"));
  let server;
  try {
    const fixture = await createRemoteReleaseFixture(root);
    const outputDir = join(root, "release");
    const names = await stageRemoteReleaseAssets({ ...fixture, outputDir });
    const requests = [];
    const proxyRoot = `/api/v1/releases/download/v${fixture.version}/`;
    const assetRoot = `/release/v${fixture.version}/`;
    server = createServer(async (request, response) => {
      const path = new URL(request.url, "http://fixture.invalid").pathname;
      requests.push(path);
      const prefix = path.startsWith(proxyRoot) ? proxyRoot : assetRoot;
      const name = path.slice(prefix.length);
      if (!path.startsWith(prefix) || !names.includes(name)) {
        response.writeHead(404).end();
      } else if (prefix === proxyRoot) {
        response.writeHead(302, { location: `${assetRoot}${name}` }).end();
      } else {
        response.writeHead(200, {
          "content-type": name.endsWith(".json") ? "application/json" : "application/gzip",
        });
        response.end(await readFile(join(outputDir, name)));
      }
    });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const baseUrl = `http://127.0.0.1:${server.address().port}${proxyRoot.slice(0, -1)}`;
    const options = {
      version: fixture.version,
      platformArch: "linux-x64",
      remoteCacheDir: join(root, "cache"),
      remoteCdnBaseUrl: baseUrl,
      refreshManifest: true,
    };
    const logger = { log() {}, logWarn() {} };
    const manifestRef = await fetchRemoteAssetManifestRefFromCdn(options, logger);
    assert.ok(manifestRef);
    assert.equal(
      requests.filter((path) => path === `${proxyRoot}manifest-linux-x64.json`).length,
      1,
    );
    const requiredReleasePaths = manifestRef.manifest.components.flatMap((component) =>
      buildRemoteComponentRequiredPaths(component.id, "linux-x64").map(
        (member) => `${component.mount}/${member}`,
      ),
    );
    const releaseDir = await ensureRemoteReleaseDirFromCdn(
      { ...options, manifestRef, requiredReleasePaths },
      logger,
    );
    for (const component of manifestRef.manifest.components) {
      assert.ok(requests.includes(`${proxyRoot}${component.artifactPath}`));
      for (const member of buildRemoteComponentRequiredPaths(component.id, "linux-x64")) {
        assert.equal(
          await readFile(join(releaseDir, component.mount, member), "utf8"),
          `linux-x64/${component.id}/${member}`,
        );
      }
    }
    assert.ok(requests.every((path) => path.startsWith(proxyRoot) || path.startsWith(assetRoot)));
    const requestCount = requests.length;
    assert.equal(
      await ensureRemoteReleaseDirFromCdn(
        { ...options, manifestRef, requiredReleasePaths },
        logger,
      ),
      releaseDir,
    );
    assert.equal(
      requests.length,
      requestCount,
      "a pinned manifest and complete cache need no second download",
    );
  } finally {
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { recursive: true, force: true });
  }
});
