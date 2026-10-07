import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { digest, miseFixture } from "../../../scripts/mise-runtime-test-fixtures.mjs";
import {
  prepareMiseRuntimeAssets,
  resolveMiseExtraResource,
  resolveMiseTarget,
  validateMiseRuntimeAssets,
} from "./prepare-mise-runtime-assets.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const execFileAsync = promisify(execFile);

test("mise target mapping covers desktop targets and explicit Linux musl", () => {
  const cases = [
    ["win32", "x64", "", "windows-x64"],
    ["win32", "arm64", "", "windows-arm64"],
    ["darwin", "x64", "", "macos-x64"],
    ["darwin", "arm64", "", "macos-arm64"],
    ["linux", "x64", "", "linux-x64"],
    ["linux", "arm64", "", "linux-arm64"],
    ["linux", "x64", "musl", "linux-x64-musl"],
    ["linux", "arm64", "musl", "linux-arm64-musl"],
  ];
  for (const [os, arch, libc, backendKey] of cases) {
    const target = resolveMiseTarget({ os, arch, libc });
    assert.equal(target.backendKey, backendKey);
    assert.equal(target.desktopTargetKey, `${os}-${arch}`);
  }
});

test("prepare publishes the fixed backend into the desktop target layout and reuses it", async (t) => {
  const { root, api, cacheDir, calls } = await miseFixture(t);
  const target = resolveMiseTarget({ os: "win32", arch: "x64", libc: "" });
  const options = { desktopRoot: root, target, backendApi: api, cacheDir };
  const first = await prepareMiseRuntimeAssets(options);
  assert.equal(first.reused, false);
  assert.match(first.backendPath, /bundled-tools[\\/]win32-x64[\\/]mise[\\/]bin[\\/]mise\.exe$/u);
  assert.equal(calls.publish, 1);
  await validateMiseRuntimeAssets(options);
  const second = await prepareMiseRuntimeAssets(options);
  assert.equal(second.reused, true);
  assert.equal(calls.publish, 1);
  assert.equal(JSON.parse(await readFile(second.manifestPath, "utf8")).platform, "windows-x64");
});

test("skip rejects missing and corrupt cache without invoking publish", async (t) => {
  const { root, api, cacheDir, calls } = await miseFixture(t);
  const target = resolveMiseTarget({ os: "darwin", arch: "arm64", libc: "" });
  const options = { desktopRoot: root, target, backendApi: api, cacheDir };
  await assert.rejects(
    prepareMiseRuntimeAssets({ ...options, skip: true }),
    /--skip only accepts a validated cache/u,
  );
  assert.equal(calls.publish, 0);
  const prepared = await prepareMiseRuntimeAssets(options);
  await writeFile(prepared.backendPath, "corrupt\n");
  await assert.rejects(
    prepareMiseRuntimeAssets({ ...options, skip: true }),
    /--skip only accepts a validated cache/u,
  );
  assert.equal(calls.publish, 1);
});

test("fixed archive provenance rejects a forged self-consistent binary manifest", async (t) => {
  const { root, api, cacheDir, calls } = await miseFixture(t);
  const target = resolveMiseTarget({ os: "win32", arch: "x64", libc: "" });
  const options = { desktopRoot: root, target, backendApi: api, cacheDir };
  const prepared = await prepareMiseRuntimeAssets(options);
  const modified = Buffer.from("replacement binary\n");
  await writeFile(prepared.backendPath, modified);
  await writeFile(
    prepared.manifestPath,
    JSON.stringify({ ...prepared.manifest, binarySha256: digest(modified) }),
  );
  await assert.rejects(
    prepareMiseRuntimeAssets({ ...options, skip: true }),
    /fixed archive|provenance/u,
  );
  assert.equal(calls.publish, 1);
});

test("old builds without fixed archive evidence or required mise files fail closed", async (t) => {
  const { root, api, cacheDir, calls } = await miseFixture(t);
  const target = resolveMiseTarget({ os: "linux", arch: "x64", libc: "glibc" });
  const options = { desktopRoot: root, target, backendApi: api, cacheDir };
  const prepared = await prepareMiseRuntimeAssets(options);
  const archive = join(cacheDir, api.MISE_ASSETS[target.backendKey]);
  await writeFile(archive, "corrupt archive\n");
  await assert.rejects(prepareMiseRuntimeAssets({ ...options, skip: true }), /archive/u);
  await rm(prepared.manifestPath);
  await assert.rejects(
    prepareMiseRuntimeAssets({ ...options, skip: true }),
    /--skip only accepts/u,
  );
  assert.equal(calls.publish, 1);
});

test("no-assets build guard refuses an empty target before the production build", async (t) => {
  const { root } = await miseFixture(t);
  const packageJson = JSON.parse(
    await readFile(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
  );
  assert.ok(
    packageJson.scripts["build:no-runtime-assets"].indexOf("verify:mise") <
      packageJson.scripts["build:no-runtime-assets"].indexOf("run-production-build"),
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        resolve(import.meta.dirname, "prepare-mise-runtime-assets.mjs"),
        "--skip",
        "--os",
        "win32",
        "--arch",
        "x64",
        "--desktop-root",
        root,
      ],
      { cwd: workspaceRoot, env: { ...process.env, LCODE_MISE_LIBC: "", LCODE_TARGET_LIBC: "" } },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /--skip only accepts a validated cache/u);
      return true;
    },
  );
});

test("extra resource registration maps the target bundle to resources/tools/mise", () => {
  assert.deepEqual(
    resolveMiseExtraResource(resolveMiseTarget({ os: "linux", arch: "x64", libc: "glibc" })),
    {
      from: "bundled-tools/linux-x64/mise",
      to: "tools/mise",
      filter: ["**/*"],
    },
  );
});

test("desktop runtime preparation only builds the selected platform and leaves remote assets explicit", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
  );
  const rootPackageJson = JSON.parse(
    await readFile(resolve(workspaceRoot, "package.json"), "utf8"),
  );
  const prepareSource = await readFile(
    resolve(import.meta.dirname, "prepare-runtime-assets.mjs"),
    "utf8",
  );
  const bootstrapSource = await readFile(resolve(workspaceRoot, "scripts/bootstrap.mjs"), "utf8");

  assert.match(
    prepareSource,
    /prepareMiseRuntimeAssets\(\{ target: resolveMiseTarget\(miseTarget\) \}\)/u,
  );
  assert.doesNotMatch(prepareSource, /runTimedPnpmScript\("prepare:remote-assets"\)/u);
  assert.equal(
    packageJson.scripts["prepare:remote-assets"],
    "node ../../scripts/prepare-prebuilds.mjs",
  );
  assert.equal(
    rootPackageJson.scripts["prepare:remote-assets"],
    "pnpm --filter @lcode/desktop prepare:remote-assets",
  );
  assert.match(
    bootstrapSource,
    /if \(withRemoteAssets\)\s*\{\s*runPnpm\(\["prepare:remote-assets"\]\)/u,
  );
});

test("desktop package registers mise validation for every build entry", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(workspaceRoot, "packages/desktop/package.json"), "utf8"),
  );
  assert.equal(packageJson.scripts["prepare:mise"], "node scripts/prepare-mise-runtime-assets.mjs");
  assert.equal(
    packageJson.scripts["verify:mise"],
    "node scripts/prepare-mise-runtime-assets.mjs --skip",
  );
  assert.match(packageJson.scripts["build:no-runtime-assets"], /verify:mise/u);
  assert.match(packageJson.scripts.build, /prepare:runtime-assets/u);
  for (const [file, pattern] of [
    ["prepare-runtime-assets.mjs", /prepareMiseRuntimeAssets/u],
    ["ensure-local-runtime-assets.mjs", /validateMiseRuntimeAssets/u],
    ["bundle.mjs", /validatePackagedMiseRuntimeAssets/u],
  ]) {
    assert.match(await readFile(resolve(import.meta.dirname, file), "utf8"), pattern);
  }
});
