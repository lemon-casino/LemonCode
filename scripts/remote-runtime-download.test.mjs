import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRemoteReleaseFixture } from "./remote-release-assets.fixture.mjs";
import { stageRemoteReleaseAssets } from "./stage-remote-release-assets.mjs";
import { buildRemoteComponentRequiredPaths } from "./prepare-prebuilds.mjs";
import { packSourceAsDeterministicTarGzip } from "./deterministic-tar-archive.mjs";

// 根脚本不声明 server 依赖，测试从目标包公开入口解析，避免依赖开发机 hoist。
const serverRequire = createRequire(new URL("../packages/server/package.json", import.meta.url));
await import("./cleanup-remote-deploy.test.mjs");
// tag 已运行 test:remote-assets；把真实 POSIX 锁收敛和下载失败传播纳入同一发行门禁。
for (const file of ["remoteDeployLock.test.js", "remoteDownloadFailure.test.js"]) {
  await import(pathToFileURL(serverRequire.resolve(`@lcode/server/remote/${file}`)).href);
}
const { ensureRemoteReleaseDirFromCdn, fetchRemoteAssetManifestRefFromCdn } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/remoteAssetCache.js")).href
);
const { createBundledRemoteAssetNetwork } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/bundledRemoteAssetSource.js")).href
);
const { deployServer } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/deploy.js")).href
);
const { LocalFixtureRemoteBackend } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/remoteMiseDeploy.fixture.js")).href
);
const { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/lcodeAgentOfficialPluginAssets.js"))
    .href
);
const { LCODE_VERSION, remoteAssetDirsSchema } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/shared")).href
);
const { createCloseEventController } = await import(
  pathToFileURL(serverRequire.resolve("@lcode/server/remote/closeEvent.js")).href
);

test("an unpublished bundled release materializes its Linux x64 runtime without a network request", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-bundled-remote-"));
  try {
    const fixture = await createRemoteReleaseFixture(root);
    const directory = join(root, "resources");
    await stageRemoteReleaseAssets({ ...fixture, outputDir: directory });
    const network = createBundledRemoteAssetNetwork(directory);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      network.fetch(
        new Request("https://offline.invalid/manifest-linux-x64.json", {
          signal: controller.signal,
        }),
      ),
      { name: "AbortError" },
    );
    assert.equal(
      (await network.fetch("https://offline.invalid/manifest-linux-x64.json", { method: "POST" }))
        .status,
      405,
    );
    const options = {
      version: fixture.version,
      platformArch: "linux-x64",
      remoteCacheDir: join(root, "cache"),
      remoteCdnBaseUrl: "https://offline.invalid/download/v9.8.7",
      remoteAssetNetwork: network,
      refreshManifest: true,
    };
    const logs = [];
    const logger = {
      log: (message) => logs.push(message),
      logWarn: (message) => logs.push(message),
    };
    const manifestRef = await fetchRemoteAssetManifestRefFromCdn(options, logger);
    assert.equal(manifestRef.manifest.appVersion, fixture.version);
    const component = manifestRef.manifest.components.find((c) => c.id === "node-runtime");
    const head = await network.fetch(`${options.remoteCdnBaseUrl}/${component.artifactPath}`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(
      Number(head.headers.get("content-length")),
      (await readFile(join(directory, component.artifactPath))).length,
    );
    const releaseDir = await ensureRemoteReleaseDirFromCdn(
      {
        ...options,
        manifestRef,
        requiredReleasePaths: ["node/linux-x64/node", "server/lcode-server.cjs"],
      },
      logger,
    );
    assert.equal(
      await readFile(join(releaseDir, "node/linux-x64/node"), "utf8"),
      "linux-x64/node-runtime/node",
    );
    assert.ok(logs.some((message) => message.includes("reading bundled resource")));
    assert.ok(logs.some((message) => message.includes("copy progress")));
    assert.ok(!logs.some((message) => /download(?:ing| required| progress)/u.test(message)));
    assert.equal((await network.fetch("https://offline.invalid/%2e%2e%2fsecret")).status, 404);
    assert.equal((await network.fetch("https://offline.invalid/not-a-release-file")).status, 404);
    await rm(join(directory, component.artifactPath));
    assert.equal(
      (await network.fetch(`${options.remoteCdnBaseUrl}/${component.artifactPath}`)).status,
      404,
    );
    await assert.rejects(
      fetchRemoteAssetManifestRefFromCdn(
        {
          ...options,
          version: "9.8.8",
          remoteCdnBaseUrl: "https://offline.invalid/download/v9.8.8",
          remoteCacheDir: join(root, "other-cache"),
        },
        logger,
      ),
      /appVersion mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled source survives startup validation and deploys to a fixture SSH host even when remote-download was selected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "lcode-bundled-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await createRemoteReleaseFixture(root, LCODE_VERSION);
  const path = join(fixture.sourceDir, "releases", LCODE_VERSION, "manifest-linux-x64.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const sources = (id) => join(root, "sources", "linux-x64", id);
  await writeFile(
    join(sources("node-runtime"), "node"),
    `#!/bin/sh\nexec '${process.execPath.replaceAll("\\", "/")}' "$@"\n`,
  );
  const mise =
    '#!/bin/sh\n[ "$1" = "--no-config" ] && [ "$2" = "version" ] || exit 1\nprintf \'%s\\n\' \'2026.10.2 linux-x64 (fixture)\'\n';
  await writeFile(join(sources("mise"), "bin/mise"), mise);
  await writeFile(
    join(sources("mise"), "backend-manifest.json"),
    JSON.stringify({
      version: "v2026.10.2",
      platform: "linux-x64",
      archiveSha256: "a".repeat(64),
      binarySha256: createHash("sha256").update(mise).digest("hex"),
    }),
  );
  for (const member of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
    const target = join(sources("glm"), "packages", member);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture plugin asset\n");
  }
  for (const component of manifest.components) {
    const archive = join(fixture.sourceDir, component.artifactPath);
    packSourceAsDeterministicTarGzip(sources(component.id), archive);
    component.sha256 = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
  }
  await writeFile(path, JSON.stringify(manifest));
  const directory = join(root, "packaged-resources");
  await stageRemoteReleaseAssets({ ...fixture, outputDir: directory });
  const descriptor = remoteAssetDirsSchema.parse({
    bundledAssetDir: directory,
    remoteCdnBaseUrl: `https://offline.invalid/download/v${LCODE_VERSION}`,
    remoteCacheDir: join(root, "cache"),
  });
  assert.equal(descriptor.bundledAssetDir, directory);
  const backend = new LocalFixtureRemoteBackend(join(root, "ssh-home"), {
    platform: "linux",
    arch: "x64",
  });
  const exec = backend.exec.bind(backend);
  backend.exec = async (command) => {
    const holder = /\.deploy\.lock\.holder-([a-f0-9-]+)\.sh/u.exec(command);
    if (!holder) return exec(command);
    // Windows Git Bash 的后台 sleep 会继承管道，不能用本机 child.close 模拟 SSH channel。
    // 只替换持久锁传输；所有组件安装和验证命令仍在临时 HOME 中实际执行。
    backend.commands.push(command);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const close = createCloseEventController();
    let release = "";
    stdin.on("data", (data) => {
      release += data.toString();
    });
    stdin.on("finish", () => {
      stdout.end();
      stderr.end();
      close.fire(release === `lcode-deploy-lock-release:${holder[1]}\n` ? 0 : 1);
    });
    setImmediate(() => stdout.write(`lcode-deploy-lock-acquired:${holder[1]}\n`));
    return { stdin, stdout, stderr, onClose: close.event };
  };
  let networkCalls = 0;
  await deployServer(backend, backend.environment, {
    ...descriptor,
    assetInstallMode: "remote-download",
    remoteAssetNetwork: {
      fetch: async () => {
        networkCalls++;
        throw new Error("network forbidden");
      },
    },
  });
  assert.equal(networkCalls, 0);
  assert.ok(backend.uploads.length > 0);
  assert.ok(await backend.exists("~/.lcode/server/lcode-server.cjs"));
  assert.ok(await backend.exists("~/.lcode/server/agents/glm/lcode.cjs"));
  assert.ok(await backend.exists("~/.lcode/server/tools/mise/bin/mise"));
  assert.ok(!backend.commands.some((command) => /curl|wget/u.test(command)));
});

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
