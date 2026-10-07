import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { bundledMisePath } from "./adapters/bundledBackend.js";

test("bundled mise is located from the application, never from cwd or environment overrides", () => {
  const root = resolve("/application/resources");
  const original = process.env.LCODE_BUNDLED_MISE_PATH;
  process.env.LCODE_BUNDLED_MISE_PATH = resolve("/outside/mise.exe");
  try {
    assert.equal(
      bundledMisePath({ platform: "win32", arch: "x64", resourcesPath: root }),
      resolve(root, "tools/mise/bin/mise.exe"),
    );
    assert.equal(
      bundledMisePath({
        platform: "linux",
        arch: "arm64",
        developmentToolsRoot: resolve("/project/packages/desktop/bundled-tools"),
      }),
      resolve("/project/packages/desktop/bundled-tools/linux-arm64/mise/bin/mise"),
    );
  } finally {
    if (original === undefined) delete process.env.LCODE_BUNDLED_MISE_PATH;
    else process.env.LCODE_BUNDLED_MISE_PATH = original;
  }
});
test("bundled host and source modules locate the same build output", () => {
  const base = resolve("/project/packages");
  const expected = resolve(base, "desktop/bundled-tools/win32-x64/mise/bin/mise.exe");
  assert.equal(
    bundledMisePath({
      platform: "win32",
      arch: "x64",
      modulePath: resolve(base, "services/src/runtime-environment/adapters/bundledBackend.ts"),
    }),
    expected,
  );
  assert.equal(
    bundledMisePath({
      platform: "win32",
      arch: "x64",
      modulePath: resolve(base, "desktop/out/host/index.js"),
    }),
    expected,
  );
});
test("packaged module derives tools beside app.asar without a host environment override", () => {
  const root = resolve("/LCode/resources");
  assert.equal(
    bundledMisePath({
      platform: "win32",
      arch: "x64",
      modulePath: resolve(root, "app.asar/out/host/index.js"),
    }),
    resolve(root, "tools/mise/bin/mise.exe"),
  );
});
test("unsupported platform and relative explicit roots are rejected", () => {
  assert.throws(() => bundledMisePath({ platform: "freebsd" }), /unavailable/);
  assert.throws(() => bundledMisePath({ resourcesPath: "relative" }), /absolute/);
});
