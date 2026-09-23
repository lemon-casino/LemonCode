import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import {
  resolveCuaNodeRuntime,
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
} from "./windowsCuaDevRuntime.js";

const ELECTRON_VERSION = "41.0.3";
const NATIVE_PACKAGE = "@crowecawcaw/xa11y-win32-x64-msvc";
const LINUX_NATIVE_PACKAGE = "@crowecawcaw/xa11y-linux-x64-gnu";

function createRuntimeFiles(platform: "linux" | "win32"): Map<string, string> {
  const nativePackage = platform === "win32" ? NATIVE_PACKAGE : LINUX_NATIVE_PACKAGE;
  const nativeBinary =
    platform === "win32" ? "xa11y.win32-x64-msvc.node" : "xa11y.linux-x64-gnu.node";
  return new Map<string, string>([
    ["helper-entry.js", 'import "./server.js";\n'],
    ["server.js", "export const serve = true;\n"],
    ["xa11y-native-loader.js", 'export const load = () => import("@crowecawcaw/xa11y");\n'],
    ["package.json", '{"name":"@zcode/zcode-cua","version":"1.2.3","type":"module"}\n'],
    ["node_modules/@crowecawcaw/xa11y/package.json", '{"name":"@crowecawcaw/xa11y"}\n'],
    ["node_modules/@crowecawcaw/xa11y/index.js", 'module.exports = require("./native.js");\n'],
    ["node_modules/@crowecawcaw/xa11y/native.js", "module.exports = {};\n"],
    [
      `node_modules/${nativePackage}/package.json`,
      `{"name":"${nativePackage}","main":"${nativeBinary}"}\n`,
    ],
    [`node_modules/${nativePackage}/${nativeBinary}`, "native fixture"],
  ]);
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixtureFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function createPackagedFixture(t: TestContext, platform: "linux" | "win32" = "win32") {
  const root = await mkdtemp(join(tmpdir(), "zcode-cua-runtime-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const resourcesPath = resolve(root, "resources");
  const runtimeRoot = resolve(resourcesPath, "tools", "cua-helper");
  const runtimeFiles = createRuntimeFiles(platform);
  for (const [path, contents] of runtimeFiles) {
    await writeFixtureFile(resolve(runtimeRoot, ...path.split("/")), contents);
  }
  const files = [...runtimeFiles.entries()]
    .map(([path, contents]) => ({ path, sha256: sha256(contents) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    schemaVersion: 1,
    packageName: "@zcode/zcode-cua",
    packageVersion: "1.2.3",
    platform,
    arch: "x64",
    electronVersion: ELECTRON_VERSION,
    entry: "helper-entry.js",
    addon: "xa11y-native-loader.js",
    files,
  };
  await writeFile(resolve(runtimeRoot, "runtime-manifest.json"), JSON.stringify(manifest));
  return { manifest, resourcesPath, root, runtimeRoot };
}

async function createDevelopmentFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zcode-cua-dev-runtime-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFixtureFile(
    resolve(root, "package.json"),
    JSON.stringify({
      name: "@zcode/zcode-cua",
      version: "1.2.3",
      zcodeCuaRuntime: {
        schema: 1,
        windows: { entry: "windows-entry.js", nativeAddon: "windows-addon.js" },
        linux: { entry: "linux-entry.js", nativeAddon: "linux-addon.js" },
        macos: { entry: "macos-entry.js", nativeAddon: "macos-addon.js" },
      },
    }),
  );
  for (const file of [
    "windows-entry.js",
    "windows-addon.js",
    "linux-entry.js",
    "linux-addon.js",
    "macos-entry.js",
    "macos-addon.js",
  ]) {
    await writeFixtureFile(resolve(root, file), "export {};\n");
  }
  return root;
}

function resolveFixture(
  resourcesPath: string,
  fileSystem?: NonNullable<Parameters<typeof resolveWindowsCuaRuntime>[0]>["fileSystem"],
  platform: "linux" | "win32" = "win32",
) {
  return resolveCuaNodeRuntime({
    platform,
    env: {},
    resourcesPath,
    arch: "x64",
    electronVersion: ELECTRON_VERSION,
    fileSystem,
  });
}

function hasResolutionError(
  reason: WindowsCuaDevRuntimeResolutionError["reason"],
  artifact?: string,
): (error: unknown) => boolean {
  return (error) =>
    error instanceof WindowsCuaDevRuntimeResolutionError &&
    error.reason === reason &&
    (artifact === undefined || error.artifact === artifact);
}

test("resolves only after verifying the complete packaged runtime closure", async (t) => {
  const fixture = await createPackagedFixture(t);
  const runtime = await resolveFixture(fixture.resourcesPath);

  assert.equal(runtime.root, fixture.runtimeRoot);
  assert.equal(runtime.entryPath, resolve(fixture.runtimeRoot, "helper-entry.js"));
  assert.equal(runtime.addonPath, resolve(fixture.runtimeRoot, "xa11y-native-loader.js"));
});

test("resolves a Linux runtime only when its manifest and native package match", async (t) => {
  const fixture = await createPackagedFixture(t, "linux");
  const runtime = await resolveFixture(fixture.resourcesPath, undefined, "linux");

  assert.equal(runtime.root, fixture.runtimeRoot);
  assert.equal(runtime.entryPath, resolve(fixture.runtimeRoot, "helper-entry.js"));
  await assert.rejects(
    resolveCuaNodeRuntime({
      platform: "win32",
      env: {},
      resourcesPath: fixture.resourcesPath,
      arch: "x64",
      electronVersion: ELECTRON_VERSION,
    }),
    hasResolutionError("incompatible-runtime-manifest", "runtime-manifest.json"),
  );
});

test("development roots select the contract for the requested Node platform", async (t) => {
  const root = await createDevelopmentFixture(t);
  const windowsRuntime = await resolveCuaNodeRuntime({
    platform: "win32",
    env: { ZCODE_CUA_DEV_ROOT: root },
  });
  const linuxRuntime = await resolveCuaNodeRuntime({
    platform: "linux",
    env: { ZCODE_CUA_DEV_ROOT: root },
  });

  assert.equal(windowsRuntime.entryPath, resolve(root, "windows-entry.js"));
  assert.equal(windowsRuntime.addonPath, resolve(root, "windows-addon.js"));
  assert.equal(linuxRuntime.entryPath, resolve(root, "linux-entry.js"));
  assert.equal(linuxRuntime.addonPath, resolve(root, "linux-addon.js"));
});

test("current zcode-cua source package is a valid Windows and Linux development root", async () => {
  const root = resolve(import.meta.dirname, "../../../zcode-cua");
  const [windowsRuntime, linuxRuntime] = await Promise.all([
    resolveCuaNodeRuntime({ platform: "win32", env: { ZCODE_CUA_DEV_ROOT: root } }),
    resolveCuaNodeRuntime({ platform: "linux", env: { ZCODE_CUA_DEV_ROOT: root } }),
  ]);

  assert.equal(windowsRuntime.entryPath, resolve(root, "helper-entry.js"));
  assert.equal(linuxRuntime.entryPath, resolve(root, "helper-entry.js"));
  assert.equal(windowsRuntime.addonPath, resolve(root, "xa11y-native-loader.js"));
  assert.equal(linuxRuntime.addonPath, resolve(root, "xa11y-native-loader.js"));
});

test("rejects tampering in a non-entry xa11y JavaScript file", async (t) => {
  const fixture = await createPackagedFixture(t);
  const artifact = "node_modules/@crowecawcaw/xa11y/native.js";
  await writeFile(resolve(fixture.runtimeRoot, ...artifact.split("/")), "tampered\n");

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("artifact-integrity-mismatch", artifact),
  );
});

test("rejects an unmanifested file in the runtime tree", async (t) => {
  const fixture = await createPackagedFixture(t);
  await writeFixtureFile(resolve(fixture.runtimeRoot, "unmanifested.js"), "export {};\n");

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("artifact-integrity-mismatch", "unmanifested.js"),
  );
});

test("preserves the stable missing-entry diagnostic before closure verification", async (t) => {
  const fixture = await createPackagedFixture(t);
  await rm(resolve(fixture.runtimeRoot, "helper-entry.js"));

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("missing-helper-entry", "helper-entry.js"),
  );
});

test("preserves the stable missing-addon diagnostic before closure verification", async (t) => {
  const fixture = await createPackagedFixture(t);
  await rm(resolve(fixture.runtimeRoot, "xa11y-native-loader.js"));

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("missing-native-addon", "xa11y-native-loader.js"),
  );
});

test("rejects legacy v1 manifests that do not list the full closure", async (t) => {
  const fixture = await createPackagedFixture(t);
  const { files: _files, ...legacyManifest } = fixture.manifest;
  await writeFile(
    resolve(fixture.runtimeRoot, "runtime-manifest.json"),
    JSON.stringify({
      ...legacyManifest,
      sha256: { entry: "0".repeat(64), addon: "0".repeat(64) },
    }),
  );

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("incompatible-runtime-manifest", "runtime-manifest.json"),
  );
});

test("rejects a symlinked directory inside the runtime closure", async (t) => {
  const fixture = await createPackagedFixture(t);
  const xa11yPath = resolve(fixture.runtimeRoot, "node_modules/@crowecawcaw/xa11y");
  const externalPath = resolve(fixture.root, "external-xa11y");
  await mkdir(externalPath);
  await rm(xa11yPath, { recursive: true });
  await symlink(externalPath, xa11yPath, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    resolveFixture(fixture.resourcesPath),
    hasResolutionError("invalid-artifact-path", "node_modules/@crowecawcaw/xa11y"),
  );
});

test("rejects a file changed between integrity reads", async (t) => {
  const fixture = await createPackagedFixture(t);
  const artifact = "node_modules/@crowecawcaw/xa11y/native.js";
  const artifactPath = resolve(fixture.runtimeRoot, ...artifact.split("/"));
  let targetReads = 0;

  await assert.rejects(
    resolveFixture(fixture.resourcesPath, {
      stat,
      lstat,
      realpath,
      readdir,
      readFile: async (path, encoding) => {
        const contents =
          encoding === "utf8" ? await readFile(path, encoding) : await readFile(path);
        if (path === artifactPath && encoding === undefined && targetReads++ === 0) {
          await writeFile(artifactPath, "changed during verification\n");
        }
        return contents;
      },
    }),
    hasResolutionError("artifact-integrity-mismatch", artifact),
  );
});
