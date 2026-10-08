import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const require = createRequire(import.meta.url);
const shellQuote = require("shell-quote");
const execFileAsync = promisify(execFile);

test("shell quoting preserves ordinary argument boundaries", () => {
  const args = ["git", "status", "path with spaces", "one'two", "$literal"];
  assert.deepEqual(shellQuote.parse(shellQuote.quote(args)), args);
});

test("shell comments cannot expose a later token through a line terminator", () => {
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    // comment token 后的普通 token 仍位于 shell 注释中，原始换行会把它变成新命令。
    assert.throws(
      () => shellQuote.quote([{ comment: "fixture" }, `first${terminator}second`]),
      (error) => error instanceof TypeError && /line terminators/.test(error.message),
    );
  }
});

for (const mode of ["worker", "run"]) {
  test(`Tinypool ignores inherited ${mode} options`, async () => {
    await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("./dependency-security-probe.mjs", import.meta.url)), mode],
      { timeout: 10_000, windowsHide: true },
    );
  });
}

test("nut-js Jimp keeps automatic PNG/JPEG/BMP buffer decoding", async () => {
  const nutRequire = createRequire(require.resolve("@nut-tree-fork/nut-js"));
  const Jimp = nutRequire("jimp");
  const image = new Jimp(2, 3, 0x336699ff);
  for (const mime of [Jimp.MIME_PNG, Jimp.MIME_JPEG, Jimp.MIME_BMP]) {
    const decoded = await Jimp.read(await image.getBufferAsync(mime));
    assert.equal(decoded.bitmap.width, 2);
    assert.equal(decoded.bitmap.height, 3);
    if (mime === Jimp.MIME_PNG) assert.equal(decoded.getPixelColor(0, 0), 0x336699ff);
  }
});

test("brace patterns preserve ordinary expansion and reject excessive nesting", () => {
  const braces = require("braces");
  assert.deepEqual(braces.expand("src/{one,two}.{ts,js}"), [
    "src/one.ts",
    "src/one.js",
    "src/two.ts",
    "src/two.js",
  ]);
  const deep = "{".repeat(1024) + "x" + "}".repeat(1024);
  for (const operation of [braces.parse, braces.compile, braces.expand]) {
    assert.throws(
      () => operation(deep),
      (error) => error instanceof SyntaxError && /depth/i.test(error.message),
    );
  }
  const cyclicAst = { type: "root", nodes: [] };
  cyclicAst.nodes.push(cyclicAst);
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(
      () => operation(cyclicAst),
      (error) => error instanceof SyntaxError && /depth/i.test(error.message),
    );
  }
});
