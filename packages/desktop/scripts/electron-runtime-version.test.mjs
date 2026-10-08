import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
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
