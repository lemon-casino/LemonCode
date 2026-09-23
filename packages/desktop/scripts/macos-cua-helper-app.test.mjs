import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  MAC_CUA_HELPER_APP_NAME,
  MAC_CUA_HELPER_BUNDLE_ID,
  MAC_CUA_PIP_PRESENTER_ENV,
  MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME,
  createMacCuaBuildVersion,
  createMacCuaSeaBootstrapSource,
  stageMacCuaHelperApp,
} from "./macos-cua-helper-app.mjs";

const ARM64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-darwin-arm64";
const X64_NATIVE_PACKAGE = "@crowecawcaw/xa11y-darwin-x64";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeFixtureFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zcode-cua-mac-stage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resourcesDir = resolve(root, "ZCode.app/Contents/Resources");
  const zcodeCuaRoot = resolve(root, "zcode-cua");
  const xa11yRoot = resolve(root, "xa11y");
  const arm64NativeRoot = resolve(root, "xa11y-darwin-arm64");
  const x64NativeRoot = resolve(root, "xa11y-darwin-x64");
  const nodeExecutablePath = resolve(root, "node");
  const compileCalls = [];
  const executableArchReads = [];
  await mkdir(resourcesDir, { recursive: true });
  await writeFixtureFile(nodeExecutablePath, "darwin arm64 node fixture");
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "package.json"),
    JSON.stringify({
      name: "@zcode/zcode-cua",
      version: "0.1.0",
      type: "module",
      zcodeCuaRuntime: {
        schema: 1,
        macos: { entry: "helper-entry.js", nativeAddon: "xa11y-native-loader.js" },
      },
    }),
  );
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "helper-entry.js"),
    'import { serve } from "./server.js";\nexport async function runHelperProcess() { serve(); }\n',
  );
  await writeFixtureFile(resolve(zcodeCuaRoot, "server.js"), "export function serve() {}\n");
  await writeFixtureFile(
    resolve(zcodeCuaRoot, "xa11y-native-loader.js"),
    'export const loadXa11y = () => import("@crowecawcaw/xa11y");\n',
  );
  await writeFixtureFile(
    resolve(xa11yRoot, "package.json"),
    JSON.stringify({ name: "@crowecawcaw/xa11y", version: "0.15.0", main: "index.js" }),
  );
  await writeFixtureFile(resolve(xa11yRoot, "index.js"), "module.exports = {};\n");
  for (const [packageRoot, packageName, arch] of [
    [arm64NativeRoot, ARM64_NATIVE_PACKAGE, "arm64"],
    [x64NativeRoot, X64_NATIVE_PACKAGE, "x64"],
  ]) {
    const binaryName = `xa11y.darwin-${arch}.node`;
    await writeFixtureFile(
      resolve(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, version: "0.15.0", main: binaryName }),
    );
    await writeFixtureFile(resolve(packageRoot, binaryName), `${arch} native fixture`);
  }
  return {
    electronPlatformName: "darwin",
    resourcesDir,
    targetPlatform: { os: "darwin", arch: "arm64", key: "darwin-arm64" },
    zcodeCuaRoot,
    appVersion: "3.14.2",
    buildIdentity: "release-2026-09-23:commit-deadbeef",
    nodeExecutablePath,
    nodeVersion: process.versions.node,
    nodeSha256: sha256(await readFile(nodeExecutablePath)),
    dependencyPackageRoots: {
      "@crowecawcaw/xa11y": xa11yRoot,
      [ARM64_NATIVE_PACKAGE]: arm64NativeRoot,
      [X64_NATIVE_PACKAGE]: x64NativeRoot,
    },
    readExecutableArchs: async (executablePath) => {
      executableArchReads.push(executablePath);
      return ["arm64"];
    },
    prepareSeaExecutable: async ({ sourceNodePath, targetPath, bootstrapSource }) => {
      assert.match(bootstrapSource, /integrity check failed/u);
      assert.match(bootstrapSource, /runHelperProcess/u);
      await copyFile(sourceNodePath, targetPath);
      await writeFile(targetPath, `${await readFile(targetPath, "utf8")}\nSEA\n`);
    },
    compilePipPresenter: async (input) => {
      compileCalls.push(input);
      await writeFile(input.targetPath, `${input.targetArch} PiP presenter fixture`);
    },
    compileCalls,
    executableArchReads,
  };
}

test("stages an open macOS Helper.app with the target xa11y package and full manifest", async (t) => {
  const fixture = await createFixture(t);
  const result = await stageMacCuaHelperApp(fixture);
  assert.equal(result.staged, true);
  assert.equal(
    result.appRoot,
    resolve(fixture.resourcesDir, "cua-helper", MAC_CUA_HELPER_APP_NAME),
  );
  assert.equal(result.manifest.bundleId, MAC_CUA_HELPER_BUNDLE_ID);
  assert.equal(result.manifest.arch, "arm64");
  assert.equal(result.manifest.appVersion, fixture.appVersion);
  assert.equal(result.manifest.buildVersion, createMacCuaBuildVersion(fixture.buildIdentity));
  assert.equal(
    result.manifest.presenter,
    `Contents/MacOS/${MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME}`,
  );
  assert.equal(result.nativePackageName, ARM64_NATIVE_PACKAGE);
  assert.deepEqual(
    fixture.compileCalls.map(({ sourcePath, targetArch, targetTriple }) => ({
      sourcePath,
      targetArch,
      targetTriple,
    })),
    [
      {
        sourcePath: resolve(import.meta.dirname, "../native/macos-cua-pip-presenter/main.swift"),
        targetArch: "arm64",
        targetTriple: "arm64-apple-macos12.0",
      },
    ],
  );
  const presenterSuffix = new RegExp(
    `Contents[\\\\/]MacOS[\\\\/]${MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME}$`,
    "u",
  );
  assert.match(fixture.compileCalls[0].targetPath, presenterSuffix);
  assert.ok(fixture.executableArchReads.some((path) => presenterSuffix.test(path)));

  const plist = await readFile(resolve(result.appRoot, "Contents/Info.plist"), "utf8");
  assert.match(plist, /<string>dev\.zcode\.cua-helper<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>3\.14\.2<\/string>/u);
  assert.match(
    plist,
    new RegExp(
      `<key>CFBundleVersion<\\/key>\\s*<string>${result.manifest.buildVersion.replaceAll(".", "\\.")}<\\/string>`,
      "u",
    ),
  );
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>12\.0<\/string>/u);
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/u);
  await assert.doesNotReject(
    readFile(
      resolve(
        result.runtimeRoot,
        "node_modules/@crowecawcaw/xa11y-darwin-arm64/xa11y.darwin-arm64.node",
      ),
    ),
  );
  await assert.rejects(
    readFile(
      resolve(result.runtimeRoot, "node_modules/@crowecawcaw/xa11y-darwin-x64/package.json"),
    ),
    { code: "ENOENT" },
  );

  const manifestPath = resolve(result.appRoot, "Contents/Resources/runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.deepEqual(manifest, result.manifest);
  assert.ok(manifest.files.some((file) => file.path === "Contents/Info.plist"));
  assert.ok(manifest.files.some((file) => file.path === "Contents/MacOS/ZCode Computer Use"));
  assert.ok(
    manifest.files.some(
      (file) => file.path === `Contents/MacOS/${MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME}`,
    ),
  );
  assert.ok(manifest.files.some((file) => file.path.endsWith("xa11y.darwin-arm64.node")));
  assert.ok(manifest.signedMutablePaths.includes("Contents/MacOS/ZCode Computer Use"));
  assert.ok(
    manifest.signedMutablePaths.includes(`Contents/MacOS/${MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME}`),
  );
  assert.ok(manifest.signedMutablePaths.some((path) => path.endsWith(".node")));
  for (const file of manifest.files) {
    assert.equal(
      file.sha256,
      sha256(await readFile(resolve(result.appRoot, ...file.path.split("/")))),
    );
  }
});

test("macOS staging is a no-op for another platform before validating build inputs", async () => {
  assert.deepEqual(await stageMacCuaHelperApp({ electronPlatformName: "linux" }), {
    staged: false,
  });
});

test("macOS staging rejects unpinned or wrong-architecture Node inputs", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    stageMacCuaHelperApp({ ...fixture, nodeSha256: undefined }),
    /ZCODE_CUA_MAC_NODE_SHA256/u,
  );
  await assert.rejects(
    stageMacCuaHelperApp({ ...fixture, readExecutableArchs: async () => ["x86_64"] }),
    /does not contain arm64/u,
  );
});

test("macOS staging compiles the PiP presenter for the requested x64 target", async (t) => {
  const fixture = await createFixture(t);
  fixture.targetPlatform = { os: "darwin", arch: "x64", key: "darwin-x64" };
  fixture.readExecutableArchs = async () => ["x86_64"];
  const result = await stageMacCuaHelperApp(fixture);
  assert.equal(result.manifest.arch, "x64");
  assert.equal(result.nativePackageName, X64_NATIVE_PACKAGE);
  assert.equal(fixture.compileCalls[0].targetArch, "x64");
  assert.equal(fixture.compileCalls[0].targetTriple, "x86_64-apple-macos12.0");
});

test("macOS staging fails closed when the PiP presenter is missing or has the wrong arch", async (t) => {
  const missingFixture = await createFixture(t);
  await assert.rejects(
    stageMacCuaHelperApp({ ...missingFixture, compilePipPresenter: async () => {} }),
    /compiled PiP presenter is missing/u,
  );

  const wrongArchFixture = await createFixture(t);
  await assert.rejects(
    stageMacCuaHelperApp({
      ...wrongArchFixture,
      readExecutableArchs: async (path) =>
        resolve(path) === resolve(wrongArchFixture.nodeExecutablePath) ? ["arm64"] : ["x86_64"],
    }),
    /must contain only arm64/u,
  );
});

test("failed PiP presenter compilation preserves the previously staged Helper.app", async (t) => {
  const fixture = await createFixture(t);
  const installed = await stageMacCuaHelperApp(fixture);
  const markerPath = resolve(installed.appRoot, "Contents/Resources/preserved.txt");
  await writeFile(markerPath, "old helper");

  await assert.rejects(
    stageMacCuaHelperApp({ ...fixture, compilePipPresenter: async () => {} }),
    /compiled PiP presenter is missing/u,
  );
  assert.equal(await readFile(markerPath, "utf8"), "old helper");
});

test("macOS Helper build version is stable, numeric, and changes with build identity", () => {
  const first = createMacCuaBuildVersion("commit-a:2026-09-23T00:00:00.000Z");
  assert.match(first, /^\d+\.\d+\.\d+$/u);
  assert.equal(first, createMacCuaBuildVersion("commit-a:2026-09-23T00:00:00.000Z"));
  assert.notEqual(first, createMacCuaBuildVersion("commit-b:2026-09-23T00:00:00.000Z"));
});

test("SEA bootstrap binds the fixed bundle and verifies the runtime before importing it", () => {
  const source = createMacCuaSeaBootstrapSource();
  assert.match(source, /dev\.zcode\.cua-helper/u);
  assert.match(source, /runtime file set changed/u);
  assert.match(source, /ZCODE_CUA_HELPER_ADDON/u);
  assert.match(source, new RegExp(MAC_CUA_PIP_PRESENTER_ENV, "u"));
  assert.match(source, new RegExp(MAC_CUA_PIP_PRESENTER_EXECUTABLE_NAME, "u"));
  assert.match(source, /manifest\.presenter !== expectedPresenter/u);
  assert.match(source, /!mutable\.has\(expectedPresenter\)/u);
  assert.match(source, /parseHelperArguments/u);
});

test("Swift PiP presenter is stdin-only, bounded, acknowledges applied updates, and non-activating", async () => {
  const source = await readFile(
    resolve(import.meta.dirname, "../native/macos-cua-pip-presenter/main.swift"),
    "utf8",
  );
  assert.match(source, /FileHandle\.standardInput/u);
  assert.match(source, /FileHandle\.standardError/u);
  assert.match(source, /maxInputLineBytes/u);
  assert.match(source, /maxPngBytes/u);
  assert.match(source, /maxCommandIdBytes/u);
  assert.match(source, /private var commandInFlight = false/u);
  assert.match(source, /handle\.readabilityHandler = nil/u);
  assert.match(source, /func resumeAfterApplied\(\)/u);
  assert.match(
    source,
    /let id = try requireCommandId\(object\["id"\]\)[\s\S]*guard let type = object\["type"\] as\? String/u,
  );
  assert.match(
    source,
    /let requiredKeys: Set<String> = \["id", "type", "pngBase64", "width", "height"\]/u,
  );
  assert.match(source, /guard keys == Set\(\["id", "type"\]\)/u);
  assert.match(source, /styleMask: \[\.borderless, \.nonactivatingPanel\]/u);
  assert.match(source, /panel\.isFloatingPanel = true/u);
  assert.match(source, /override var canBecomeKey: Bool \{ false \}/u);
  assert.match(source, /private let applicationDelegate = PresenterApplicationDelegate\(\)/u);
  assert.match(source, /setActivationPolicy\(\.accessory\)/u);
  assert.ok(source.includes('Data("{\\"type\\":\\"ready\\",\\"version\\":1}\\n".utf8)'));
  assert.ok(source.includes(String.raw`Data("{\"id\":\"\(id)\",\"type\":\"applied\"}\n".utf8)`));
  assert.ok(
    source.includes(
      String.raw`Data("{\"id\":\"\(id)\",\"type\":\"error\",\"error\":\"invalid_command\"}\n".utf8)`,
    ),
  );
  assert.match(source, /try controller\.show[\s\S]*writeApplied\(id: id\)/u);
  assert.match(source, /writeApplied\(id: id\)[\s\S]*reader\?\.resumeAfterApplied\(\)/u);
  assert.match(
    source,
    /controller\.hide\(\)[\s\S]*writeApplied\(id: id\)[\s\S]*reader\?\.resumeAfterApplied\(\)/u,
  );
  assert.match(source, /controller\.close\(\)[\s\S]*writeApplied\(id: appliedId\)/u);
  assert.doesNotMatch(
    source,
    /URLSession|Network|NWConnection|FileManager|Data\(contentsOf:|makeKeyAndOrderFront|NSApp\.activate/u,
  );
});
