import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("packaged Electron uses the same locked runtime as the workspace", async () => {
  const require = createRequire(import.meta.url);
  const installed = require("electron/package.json").version;
  const { default: config } = await import("../electron-builder.config.js");
  assert.match(installed, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u);
  assert.equal(config.electronVersion, installed);
});

test("DMG only copies real inputs and lets the builder generate hidden resources", async () => {
  const { default: config } = await import("../electron-builder.config.js");
  const desktopRoot = resolve(import.meta.dirname, "..");
  await Promise.all(
    [config.dmg.background, config.dmg.icon].map((path) => access(resolve(desktopRoot, path))),
  );
  // v3.17.1 的 macOS 构建把镜像内部生成文件误当作外部源文件，ditto 因源路径不存在失败。
  assert.deepEqual(config.dmg.contents, [
    { x: 130, y: 220 },
    { x: 410, y: 220, type: "link", path: "/Applications" },
  ]);
});

test("Mac package declares why user-initiated local-network SSH access is needed", async () => {
  const { default: config } = await import("../electron-builder.config.js");
  const description = config.mac.extendInfo.NSLocalNetworkUsageDescription;
  assert.equal(typeof description, "string");
  assert.ok(description.includes(config.productName));
  assert.match(description, /SSH/iu);
  assert.match(description, /local network/iu);
});

test("Mac artifact check reads the actual plist without rewriting signed inputs", async (t) => {
  const { verifyMacLocalNetworkUsage } = await import("./macos-local-network-metadata.mjs");
  const directory = await mkdtemp(join(tmpdir(), "lcode-mac network-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plistPath = join(directory, "Info.plist");
  const original = '<plist version="1.0"><dict/></plist>\n';
  await writeFile(plistPath, original);
  let calls = 0;
  await verifyMacLocalNetworkUsage({
    electronPlatformName: "darwin",
    resourcesDir: join(directory, "Resources"),
    run: async (command, args, options) => {
      calls++;
      assert.equal(command, "/usr/bin/plutil");
      assert.deepEqual(args, ["-convert", "json", "-o", "-", plistPath]);
      assert.ok(options.timeout > 0);
      return { stdout: JSON.stringify({ NSLocalNetworkUsageDescription: "Local SSH access" }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(await readFile(plistPath, "utf8"), original);
});

test("Mac artifact check rejects missing, blank or invalid local-network declarations", async () => {
  const { verifyMacLocalNetworkUsage } = await import("./macos-local-network-metadata.mjs");
  for (const description of [undefined, "", " \n", false, 1, ["SSH"]]) {
    await assert.rejects(
      verifyMacLocalNetworkUsage({
        electronPlatformName: "darwin",
        resourcesDir: "/fixture/LCode.app/Contents/Resources",
        run: async () => ({
          stdout: JSON.stringify({ NSLocalNetworkUsageDescription: description }),
        }),
      }),
      /NSLocalNetworkUsageDescription/u,
    );
  }
  await assert.rejects(
    verifyMacLocalNetworkUsage({
      electronPlatformName: "darwin",
      resourcesDir: "/fixture/LCode.app/Contents/Resources",
      run: async () => {
        throw new Error("plist read failed");
      },
    }),
    /plist read failed/u,
  );
  await assert.rejects(
    verifyMacLocalNetworkUsage({
      electronPlatformName: "darwin",
      resourcesDir: "/fixture/LCode.app/Contents/Resources",
      run: async () => ({ stdout: "invalid plist output" }),
    }),
    SyntaxError,
  );
});

test("Windows and Linux packaging do not invoke the macOS plist tool", async () => {
  const { verifyMacLocalNetworkUsage } = await import("./macos-local-network-metadata.mjs");
  for (const electronPlatformName of ["win32", "linux"]) {
    await verifyMacLocalNetworkUsage({
      electronPlatformName,
      resourcesDir: "/fixture/resources",
      run: async () => assert.fail("non-Mac packaging invoked plutil"),
    });
  }
});
