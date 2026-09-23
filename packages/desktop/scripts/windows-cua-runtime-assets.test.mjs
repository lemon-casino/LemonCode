import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  stageCuaNodeRuntimeAssets,
  stageWindowsCuaRuntimeAssets,
} from "./windows-cua-runtime-assets.mjs";

const X64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-win32-x64-msvc";
const ARM64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-win32-arm64-msvc";
const LINUX_X64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-linux-x64-gnu";
const LINUX_ARM64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-linux-arm64-gnu";

async function writeFixtureFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function createLinuxElfFixture(arch, glibcVersion = "2.28") {
  const versionNames = Buffer.from(`\0GLIBC_2.2.5\0GLIBC_${glibcVersion}\0`, "ascii");
  const bytes = Buffer.alloc(64 + versionNames.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(arch === "x64" ? 62 : 183, 18);
  versionNames.copy(bytes, 64);
  return bytes;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-cua-stage-test-"));
  const appOutDir = resolve(root, "out");
  const zcodeCuaRoot = resolve(root, "zcode-cua");
  const xa11yRoot = resolve(root, "xa11y");
  const x64NativeRoot = resolve(root, "xa11y-win32-x64-msvc");
  const arm64NativeRoot = resolve(root, "xa11y-win32-arm64-msvc");
  const linuxX64NativeRoot = resolve(root, "xa11y-linux-x64-gnu");
  const linuxArm64NativeRoot = resolve(root, "xa11y-linux-arm64-gnu");
  await mkdir(appOutDir, { recursive: true });
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "package.json"),
    JSON.stringify({
      name: "@zcode/zcode-cua",
      version: "1.2.3",
      type: "module",
      zcodeCuaRuntime: {
        schema: 1,
        windows: { entry: "helper-entry.js", nativeAddon: "xa11y-native-loader.js" },
        linux: { entry: "helper-entry.js", nativeAddon: "xa11y-native-loader.js" },
      },
    }),
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "helper-entry.js"),
    'import { serve } from "./server.js";\nserve();\n',
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "server.js"),
    [
      'export { helper } from "./nested/helper.js";',
      'export const deferred = () => import("./nested/deferred.js");',
      "const example = 'import(\"./phantom.js\")';",
      '// import "./comment-only.js";',
      "export function serve() { return example; }",
      "",
    ].join("\n"),
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "nested/helper.js"),
    "export const helper = true;\n",
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "nested/deferred.js"),
    "export const deferred = true;\n",
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "xa11y-native-loader.js"),
    'export const load = () => import("@crowecawcaw/xa11y");\n',
  );
  await writeFixtureFile(resolve(zcodeCuaRoot, "unused.js"), "throw new Error('not staged');\n");

  await writeFixtureFile(
    resolve(xa11yRoot, "package.json"),
    JSON.stringify({ name: "@crowecawcaw/xa11y", version: "0.15.0", main: "index.js" }),
  );
  await writeFixtureFile(
    resolve(xa11yRoot, "index.js"),
    'module.exports = require("./native.js");\n',
  );
  await writeFixtureFile(resolve(xa11yRoot, "native.js"), "module.exports = {};\n");
  await writeFixtureFile(resolve(xa11yRoot, "README.md"), "xa11y fixture\n");

  for (const [packageRoot, packageName, arch] of [
    [x64NativeRoot, X64_NATIVE_PACKAGE, "x64"],
    [arm64NativeRoot, ARM64_NATIVE_PACKAGE, "arm64"],
  ]) {
    const binaryName = `xa11y.win32-${arch}-msvc.node`;
    await writeFixtureFile(
      resolve(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, version: "0.15.0", main: binaryName }),
    );
    await writeFixtureFile(resolve(packageRoot, binaryName), `${arch} native fixture`);
  }
  for (const [packageRoot, packageName, arch] of [
    [linuxX64NativeRoot, LINUX_X64_NATIVE_PACKAGE, "x64"],
    [linuxArm64NativeRoot, LINUX_ARM64_NATIVE_PACKAGE, "arm64"],
  ]) {
    const binaryName = `xa11y.linux-${arch}-gnu.node`;
    await writeFixtureFile(
      resolve(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, version: "0.15.0", main: binaryName }),
    );
    await writeFixtureFile(resolve(packageRoot, binaryName), createLinuxElfFixture(arch));
  }

  return {
    appOutDir,
    dependencyPackageRoots: {
      "@crowecawcaw/xa11y": xa11yRoot,
      [X64_NATIVE_PACKAGE]: x64NativeRoot,
      [ARM64_NATIVE_PACKAGE]: arm64NativeRoot,
      [LINUX_X64_NATIVE_PACKAGE]: linuxX64NativeRoot,
      [LINUX_ARM64_NATIVE_PACKAGE]: linuxArm64NativeRoot,
    },
    zcodeCuaRoot,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("stages the Windows helper closure and target xa11y binary", async () => {
  const fixture = await createFixture();
  const result = await stageWindowsCuaRuntimeAssets({
    ...fixture,
    electronPlatformName: "win32",
    electronVersion: "41.0.3",
    targetPlatform: { os: "win32", arch: "x64", key: "win32-x64" },
  });

  assert.equal(result.staged, true);
  assert.deepEqual(result.runtimeModules, [
    "helper-entry.js",
    "nested/deferred.js",
    "nested/helper.js",
    "server.js",
    "xa11y-native-loader.js",
  ]);
  const runtimeRoot = result.runtimeRoot;
  await assert.doesNotReject(readFile(resolve(runtimeRoot, "nested/helper.js")));
  await assert.rejects(readFile(resolve(runtimeRoot, "unused.js")), { code: "ENOENT" });
  await assert.doesNotReject(
    readFile(
      resolve(
        runtimeRoot,
        "node_modules/@crowecawcaw/xa11y-win32-x64-msvc/xa11y.win32-x64-msvc.node",
      ),
    ),
  );
  await assert.rejects(
    readFile(resolve(runtimeRoot, "node_modules/@crowecawcaw/xa11y-win32-arm64-msvc/package.json")),
    { code: "ENOENT" },
  );

  const manifest = JSON.parse(
    await readFile(resolve(runtimeRoot, "runtime-manifest.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest).sort(), [
    "addon",
    "arch",
    "electronVersion",
    "entry",
    "files",
    "packageName",
    "packageVersion",
    "platform",
    "schemaVersion",
  ]);
  assert.equal(manifest.arch, "x64");
  assert.equal(manifest.electronVersion, "41.0.3");
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    [
      "helper-entry.js",
      "nested/deferred.js",
      "nested/helper.js",
      "node_modules/@crowecawcaw/xa11y-win32-x64-msvc/package.json",
      "node_modules/@crowecawcaw/xa11y-win32-x64-msvc/xa11y.win32-x64-msvc.node",
      "node_modules/@crowecawcaw/xa11y/README.md",
      "node_modules/@crowecawcaw/xa11y/index.js",
      "node_modules/@crowecawcaw/xa11y/native.js",
      "node_modules/@crowecawcaw/xa11y/package.json",
      "package.json",
      "server.js",
      "xa11y-native-loader.js",
    ],
  );
  for (const file of manifest.files) {
    assert.deepEqual(Object.keys(file).sort(), ["path", "sha256"]);
    assert.equal(
      file.sha256,
      sha256(await readFile(resolve(runtimeRoot, ...file.path.split("/")))),
    );
  }
});

test("stages the Linux helper closure with only the target xa11y binary", async () => {
  const fixture = await createFixture();
  const result = await stageCuaNodeRuntimeAssets({
    ...fixture,
    electronPlatformName: "linux",
    electronVersion: "41.0.3",
    targetPlatform: { os: "linux", arch: "arm64", key: "linux-arm64" },
  });

  assert.equal(result.staged, true);
  assert.equal(result.nativePackageName, LINUX_ARM64_NATIVE_PACKAGE);
  assert.equal(result.manifest.platform, "linux");
  assert.equal(result.manifest.arch, "arm64");
  await assert.doesNotReject(
    readFile(
      resolve(
        result.runtimeRoot,
        "node_modules/@crowecawcaw/xa11y-linux-arm64-gnu/xa11y.linux-arm64-gnu.node",
      ),
    ),
  );
  await assert.rejects(
    readFile(
      resolve(result.runtimeRoot, "node_modules/@crowecawcaw/xa11y-linux-x64-gnu/package.json"),
    ),
    { code: "ENOENT" },
  );
});

test("stages Linux from the Linux runtime contract instead of the Windows contract", async () => {
  const fixture = await createFixture();
  const packageJsonPath = resolve(fixture.zcodeCuaRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.zcodeCuaRuntime.windows.entry = "windows-only-entry.js";
  await writeFile(packageJsonPath, JSON.stringify(packageJson));

  await assert.doesNotReject(
    stageCuaNodeRuntimeAssets({
      ...fixture,
      electronPlatformName: "linux",
      electronVersion: "41.0.3",
      targetPlatform: { os: "linux", arch: "x64", key: "linux-x64" },
    }),
  );
});

test("rejects a Linux native addon built for the wrong ELF architecture", async () => {
  const fixture = await createFixture();
  const nativeRoot = fixture.dependencyPackageRoots[LINUX_ARM64_NATIVE_PACKAGE];
  await writeFile(resolve(nativeRoot, "xa11y.linux-arm64-gnu.node"), createLinuxElfFixture("x64"));

  await assert.rejects(
    stageCuaNodeRuntimeAssets({
      ...fixture,
      electronPlatformName: "linux",
      electronVersion: "41.0.3",
      targetPlatform: { os: "linux", arch: "arm64", key: "linux-arm64" },
    }),
    /ELF architecture does not match linux-arm64/u,
  );
});

test("rejects a Linux native addon requiring a newer glibc than 2.28", async () => {
  const fixture = await createFixture();
  const nativeRoot = fixture.dependencyPackageRoots[LINUX_X64_NATIVE_PACKAGE];
  await writeFile(
    resolve(nativeRoot, "xa11y.linux-x64-gnu.node"),
    createLinuxElfFixture("x64", "2.29"),
  );

  await assert.rejects(
    stageCuaNodeRuntimeAssets({
      ...fixture,
      electronPlatformName: "linux",
      electronVersion: "41.0.3",
      targetPlatform: { os: "linux", arch: "x64", key: "linux-x64" },
    }),
    /requires GLIBC_2\.29; maximum supported is GLIBC_2\.28/u,
  );
});

test("is a no-op for non-Windows targets before validating paths", async () => {
  assert.deepEqual(
    await stageWindowsCuaRuntimeAssets({
      electronPlatformName: "darwin",
      appOutDir: "not-absolute",
      electronVersion: "",
      targetPlatform: null,
      zcodeCuaRoot: "not-absolute",
    }),
    { staged: false },
  );
});

test("rejects a runtime contract path that escapes the package", async () => {
  const fixture = await createFixture();
  const packageJsonPath = resolve(fixture.zcodeCuaRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.zcodeCuaRuntime.windows.entry = "../outside.js";
  await writeFile(packageJsonPath, JSON.stringify(packageJson));

  await assert.rejects(
    stageWindowsCuaRuntimeAssets({
      ...fixture,
      electronPlatformName: "win32",
      electronVersion: "41.0.3",
      targetPlatform: { os: "win32", arch: "x64", key: "win32-x64" },
    }),
    /runtime entry must be a canonical relative path/u,
  );
});

test("rejects a mismatched target architecture before staging", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    stageWindowsCuaRuntimeAssets({
      ...fixture,
      electronPlatformName: "win32",
      electronVersion: "41.0.3",
      targetPlatform: { os: "win32", arch: "x64", key: "win32-arm64" },
    }),
    /unsupported CUA Node target/u,
  );
});
