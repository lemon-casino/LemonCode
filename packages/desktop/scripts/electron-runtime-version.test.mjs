import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

test("packaged Electron uses the same locked runtime as the workspace", async () => {
  const require = createRequire(import.meta.url);
  const installed = require("electron/package.json").version;
  const { default: config } = await import("../electron-builder.config.js");
  assert.match(installed, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u);
  assert.equal(config.electronVersion, installed);
});
