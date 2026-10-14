import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  RemoteDownloadAssetInstaller,
  type RemoteDownloadAssetInstallerOptions,
} from "./remoteAssetInstaller.js";
import { createTarGzArchive } from "./localTarGz.js";
import { quotePosixShellArg } from "./posixShell.js";
import { REMOTE_BASE } from "./deployShared.js";
import { createMiseDeployFixture, MISE_TEST_MEMBERS } from "./remoteMiseDeploy.fixture.js";
import { deployMiseRuntime } from "./runtimeToolDeploy.js";

async function fixture(
  t: TestContext,
  mode: "http-failure" | "sha-failure" | "tar-failure" | "success" | "missing-member" | "head-hang",
  options: Partial<RemoteDownloadAssetInstallerOptions> & {
    componentLockAcquireTimeoutMs?: number;
    artifactHeadTimeoutMs?: number;
  } = {},
) {
  const f = await createMiseDeployFixture(t);
  if (mode === "missing-member") {
    await createTarGzArchive(
      f.archivePath,
      ["bin", "README.md", "backend-manifest.json"].map((name) => ({
        sourcePath: join(f.sourceDir, name),
        archivePath: name,
      })),
    );
  }
  const archive = ["success", "missing-member", "head-hang"].includes(mode)
    ? await readFile(f.archivePath)
    : Buffer.from("invalid fixture archive");
  const component = f.manifestRef.manifest.components[0]!;
  if (mode === "tar-failure" || mode === "missing-member")
    component.sha256 = createHash("sha256").update(archive).digest("hex");
  const server = createServer((request, response) => {
    if (mode === "head-hang" && request.method === "HEAD") return;
    response.writeHead(mode === "http-failure" ? 404 : 200, { "content-length": archive.length });
    response.end(archive);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  f.manifestRef.releaseBaseCandidatesForComponents = [`http://127.0.0.1:${address.port}`];
  const installer = new RemoteDownloadAssetInstaller(
    f.backend,
    { version: "fixture-app", platformArch: f.platformArch, ...options },
    { download: "curl", sha256: "sha256sum", tar: "tar" },
    { log() {}, logWarn() {} },
    Promise.resolve(f.manifestRef),
  );
  return { ...f, installer, component };
}

for (const mode of ["http-failure", "sha-failure", "tar-failure"] as const) {
  test(`remote ${mode} propagates the real failure before mise copy or ready publication`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(
      deployMiseRuntime(
        f.backend,
        f.backend.environment,
        { ...f, installer: f.installer },
        { log() {}, logWarn() {} },
      ),
      (error: Error) => {
        assert.match(error.message, /remote command failed with exit code/);
        assert.doesNotMatch(error.message, /cp:|cannot stat/);
        if (mode === "http-failure") assert.match(error.message, /404/);
        if (mode === "sha-failure") assert.match(error.message, /sha256 mismatch/);
        return true;
      },
    );
    assert.ok(f.backend.commands.every((command) => !command.includes("cp -R")));
    const componentDir = `${REMOTE_BASE}/asset-cache/components/${f.platformArch}/mise/${f.component.sha256}`;
    assert.equal(await f.backend.exists(`${componentDir}/.ready`), false);
    assert.equal(await f.backend.exists(`${REMOTE_BASE}/.asset-components/mise.json`), false);
  });
}

test("a cold remote download publishes and installs a complete verified mise component", async (t) => {
  const f = await fixture(t, "success");
  await deployMiseRuntime(
    f.backend,
    f.backend.environment,
    { ...f, installer: f.installer },
    { log() {}, logWarn() {} },
  );
  for (const member of MISE_TEST_MEMBERS)
    assert.equal(await f.backend.exists(`${REMOTE_BASE}/tools/mise/${member}`), true);
  assert.equal(await f.backend.exists(`${REMOTE_BASE}/.asset-components/mise.json`), true);
});

test("a valid SHA archive missing mandatory members never publishes a ready cache", async (t) => {
  const f = await fixture(t, "missing-member");
  await assert.rejects(
    deployMiseRuntime(
      f.backend,
      f.backend.environment,
      { ...f, installer: f.installer },
      { log() {}, logWarn() {} },
    ),
    /LICENSE/,
  );
  const cache = `${REMOTE_BASE}/asset-cache/components/${f.platformArch}/mise/${f.component.sha256}`;
  assert.equal(await f.backend.exists(`${cache}/.ready`), false);
  assert.ok(f.backend.commands.every((command) => !command.includes("cp -R")));
});

test("remote component locks have a bounded wait and preserve the current owner", async (t) => {
  const f = await fixture(t, "success", { componentLockAcquireTimeoutMs: 40 });
  const lockDir = `${REMOTE_BASE}/asset-cache/components/${f.platformArch}/mise/${f.component.sha256}.lock`;
  await mkdir(f.backend.localPath(lockDir), { recursive: true });
  await writeFile(f.backend.localPath(`${lockDir}/owner`), "other-deployment");
  const exec = f.backend.exec.bind(f.backend);
  // 旧实现无限 mkdir；测试自己的 exec 预算保证复现失败也不会留下等待子进程。
  let finished: Promise<number> | undefined;
  f.backend.exec = async (command) => {
    const stream = await exec(`timeout -k 1 2 sh -c ${quotePosixShellArg(command)}`);
    finished = new Promise((resolve) => stream.onClose(resolve));
    return stream;
  };
  await assert.rejects(
    deployMiseRuntime(
      f.backend,
      f.backend.environment,
      { ...f, installer: f.installer },
      { log() {}, logWarn() {} },
    ),
    /lock acquisition timed out/,
  );
  await finished;
  assert.equal(await f.backend.readFile(`${lockDir}/owner`), "other-deployment");
});

test("cancellation reaches optional artifact HEAD and never starts remote downloading", async (t) => {
  const controller = new AbortController();
  let onHead: (signal: AbortSignal | null | undefined) => void = () => {};
  const head = new Promise<AbortSignal | null | undefined>((resolve) => {
    onHead = resolve;
  });
  const f = await fixture(t, "success", {
    signal: controller.signal,
    remoteAssetNetwork: {
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          onHead(init?.signal);
          (init?.signal ?? controller.signal).addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
        }),
    },
  });
  const outcome = assert.rejects(
    deployMiseRuntime(
      f.backend,
      f.backend.environment,
      { ...f, installer: f.installer, signal: controller.signal },
      { log() {}, logWarn() {} },
    ),
    { name: "AbortError" },
  );
  const signal = await head;
  controller.abort();
  await outcome;
  assert.ok(signal, "metadata request must receive the current connection cancellation");
  assert.ok(f.backend.commands.every((command) => !command.includes("curl")));
});

test("a stalled optional HEAD times out and still installs the verified component", async (t) => {
  const f = await fixture(t, "head-hang", { artifactHeadTimeoutMs: 40 });
  await deployMiseRuntime(
    f.backend,
    f.backend.environment,
    { ...f, installer: f.installer },
    { log() {}, logWarn() {} },
  );
  assert.equal(await f.backend.exists(`${REMOTE_BASE}/.asset-components/mise.json`), true);
});

test("directory requirements are mapped under the source mount before checking a cached component", async (t) => {
  const f = await fixture(t, "success");
  const cache = `${REMOTE_BASE}/asset-cache/components/${f.platformArch}/mise/${f.component.sha256}`;
  await cp(f.sourceDir, f.backend.localPath(cache), { recursive: true });
  await mkdir(f.backend.localPath(`${cache}/nested`), { recursive: true });
  await writeFile(f.backend.localPath(`${cache}/nested/file.txt`), "nested member");
  await writeFile(f.backend.localPath(`${cache}/.ready`), "ready");
  const exec = f.backend.exec.bind(f.backend);
  f.backend.exec = async (command) => {
    if (command.includes("curl"))
      throw new Error("a complete nested cache must not be downloaded again");
    return exec(command);
  };
  await f.installer.installDirectory({
    componentId: "mise",
    sourceRelativePath: `${f.sourceRelativePath}/nested`,
    remoteDir: `${REMOTE_BASE}/nested-target`,
    requiredRelativePaths: ["file.txt"],
  });
  assert.equal(await f.backend.readFile(`${REMOTE_BASE}/nested-target/file.txt`), "nested member");
});
