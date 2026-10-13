import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { bundledMisePath } from "./adapters/bundledBackend.js";

for (const format of ["esm", "cjs"] as const) {
  test(`the ${format} bundle locates its own backend without an explicit module path`, async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "lcode-backend 包 % "));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = resolve(root, format === "cjs" ? "server.cjs" : "host.mjs");
    // 使用 server 既有的 URL/dirname CJS 合同，不给 filename 添加测试专用兼容映射。
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, "adapters/bundledBackend.ts")],
      outfile: output,
      bundle: true,
      platform: "node",
      target: "node22",
      format,
      logLevel: "silent",
      ...(format === "cjs"
        ? {
            banner: {
              js: 'var __import_meta_url = require("url").pathToFileURL(__filename).href; var __import_meta_dirname = __dirname;',
            },
            define: {
              "import.meta.url": "__import_meta_url",
              "import.meta.dirname": "__import_meta_dirname",
            },
          }
        : {}),
    });
    const compiled =
      format === "cjs"
        ? createRequire(import.meta.url)(output)
        : await import(pathToFileURL(output).href);
    for (const platform of ["linux", "darwin", "win32"] as const) {
      assert.equal(
        compiled.bundledMisePath({ platform, arch: "x64" }),
        resolve(root, "tools/mise/bin", platform === "win32" ? "mise.exe" : "mise"),
      );
    }
    assert.deepEqual(result.warnings, []);
  });
}

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
