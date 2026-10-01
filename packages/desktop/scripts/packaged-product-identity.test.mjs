import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { desktopProductIdentities } from "./desktop-product-identity.mjs";
import {
  assertCrossBrandIdentity,
  resolvePackagedProductLayout,
  verifyPackagedProductIdentity,
} from "./packaged-product-identity.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

async function writeFixtureFiles(paths) {
  for (const filePath of paths) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "fixture");
  }
}

test("正式 LCode 身份在 macOS、Windows、Linux 均不复用 ZCode 标识", () => {
  const identity = desktopProductIdentities.production;
  assert.doesNotThrow(() => assertCrossBrandIdentity(identity));
  assert.throws(
    () => assertCrossBrandIdentity({ ...identity, appId: "dev.zcode.app" }),
    /appId.*ZCode/iu,
  );
  assert.throws(
    () => assertCrossBrandIdentity({ ...identity, linuxPackageName: "zcode" }),
    /linuxPackageName.*ZCode/iu,
  );
});

test("六个正式构建目标解析为独立的 LCode bundle、可执行文件和安装包", () => {
  const identity = desktopProductIdentities.production;
  const mac = resolvePackagedProductLayout({
    os: "mac",
    arch: "arm64",
    distRoot: "/dist",
    version: "3.16.2",
    identity,
  });
  assert.match(mac.applicationPath, /mac-arm64[/\\]LCode\.app$/u);
  assert.match(mac.executablePath, /LCode\.app[/\\]Contents[/\\]MacOS[/\\]LCode$/u);
  assert.deepEqual(Object.keys(mac.artifactPaths).sort(), ["dmg", "zip"]);

  const windows = resolvePackagedProductLayout({
    os: "win",
    arch: "x64",
    distRoot: "/dist",
    version: "3.16.2",
    identity,
  });
  assert.match(windows.executablePath, /win-unpacked[/\\]LCode\.exe$/u);
  assert.match(windows.artifactPaths.nsis, /LCode-3\.16\.2-win-x64\.exe$/u);

  const linux = resolvePackagedProductLayout({
    os: "linux",
    arch: "arm64",
    distRoot: "/dist",
    version: "3.16.2",
    identity,
  });
  assert.match(linux.executablePath, /linux-arm64-unpacked[/\\]lcode$/u);
  assert.match(linux.artifactPaths.deb, /linux-arm64\.deb$/u);
  assert.match(linux.artifactPaths.rpm, /linux-aarch64\.rpm$/u);
  assert.match(linux.artifactPaths.pacman, /linux-aarch64\.pkg\.tar\.zst$/u);
});

test("测试后端 Preview 包的身份校验定位 _TEST 安装包", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-preview-identity-"));
  const identity = desktopProductIdentities.preview;
  const layout = resolvePackagedProductLayout({
    os: "win",
    arch: "x64",
    distRoot: directory,
    version: "3.16.5",
    identity,
    artifactSuffix: "_TEST",
  });
  try {
    assert.match(layout.artifactPaths.nsis, /LCode Preview-3\.16\.5-win-x64_TEST\.exe$/u);
    await writeFixtureFiles([layout.executablePath, ...Object.values(layout.artifactPaths)]);
    const result = verifyPackagedProductIdentity({
      os: "win",
      arch: "x64",
      distRoot: directory,
      version: "3.16.5",
      identity,
      artifactSuffix: "_TEST",
      readNativeIdentity: () => ({ productName: "LCode Preview" }),
    });
    assert.equal(result.layout.artifactPaths.nsis, layout.artifactPaths.nsis);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("实际产物身份校验覆盖 macOS Bundle ID、Windows ProductName 和 Linux 包名", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-product-identity-"));
  const identity = desktopProductIdentities.production;
  try {
    for (const [os, arch] of [
      ["mac", "x64"],
      ["win", "x64"],
      ["linux", "x64"],
    ]) {
      const layout = resolvePackagedProductLayout({
        os,
        arch,
        distRoot: directory,
        version: "3.16.2",
        identity,
      });
      await writeFixtureFiles([layout.executablePath, ...Object.values(layout.artifactPaths)]);
      const result = verifyPackagedProductIdentity({
        os,
        arch,
        distRoot: directory,
        version: "3.16.2",
        identity,
        readNativeIdentity: ({ kind }) => {
          if (kind === "mac-bundle") return { appId: "dev.lcode.app", productName: "LCode" };
          if (kind === "windows-pe") return { productName: "LCode" };
          return { packageName: "lcode" };
        },
      });
      assert.equal(result.productName, "LCode");
    }

    const linuxLayout = resolvePackagedProductLayout({
      os: "linux",
      arch: "x64",
      distRoot: directory,
      version: "3.16.2",
      identity,
    });
    assert.throws(
      () =>
        verifyPackagedProductIdentity({
          os: "linux",
          arch: "x64",
          distRoot: directory,
          version: "3.16.2",
          identity,
          readNativeIdentity: ({ path }) => ({
            packageName: path === linuxLayout.artifactPaths.rpm ? "zcode" : "lcode",
          }),
        }),
      /rpm.*zcode.*lcode/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("正式 bundle 入口在产物生成后强制执行跨平台身份校验", async () => {
  const bundleSource = await import("node:fs/promises").then(({ readFile }) =>
    readFile(resolve(desktopRoot, "scripts/bundle.mjs"), "utf8"),
  );
  assert.match(bundleSource, /verifyPackagedProductIdentity/);
  assert.match(bundleSource, /bundle:verify-product-identity/);
});
