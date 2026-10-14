import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assembleMobileWeb } from "./mobile-web-assembly.mjs";

test("连续装配保留双方资源，过滤 map；准备失败不触及上次完整 public", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "lcode-site-assembly-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const distDir = resolve(dir, "dist");
  const outputDir = resolve(dir, "public");
  await mkdir(resolve(distDir, "assets"), { recursive: true });
  await writeFile(
    resolve(distDir, "index.html"),
    '<base href="/"><script src="./assets/main.js"></script>',
  );
  await writeFile(resolve(distDir, "assets/main.js"), "console.info('client');");
  await writeFile(resolve(distDir, "assets/main.js.map"), "private source");
  await writeFile(resolve(distDir, "THIRD_PARTY_NOTICES.txt"), "notices");
  for (let i = 0; i < 2; i++) {
    await assembleMobileWeb({ distDir, outputDir });
    assert.match(await readFile(resolve(outputDir, "site/index.html"), "utf8"), /data-lcode-site/);
    assert.equal(await readFile(resolve(outputDir, "THIRD_PARTY_NOTICES.txt"), "utf8"), "notices");
    const entry = await readFile(resolve(outputDir, "site/assets/remote-entry.js"), "utf8");
    assert.ok(entry.length < 10_000);
    assert.equal(entry.includes("react-dom"), false);
    await assert.rejects(access(resolve(outputDir, "assets/main.js.map")));
    for (const file of ["provider-accounts.png", "provider-accounts-more.png"])
      await assert.rejects(access(resolve(outputDir, "site/assets", file)));
  }
  const previous = await readFile(resolve(outputDir, "index.html"), "utf8");
  await assert.rejects(
    assembleMobileWeb({
      distDir,
      outputDir,
      buildSite: async () => {
        throw new Error("site build failed");
      },
    }),
    /site build failed/,
  );
  assert.equal(await readFile(resolve(outputDir, "index.html"), "utf8"), previous);
  await writeFile(resolve(distDir, "index.html"), '<script src="./assets/missing.js"></script>');
  await assert.rejects(assembleMobileWeb({ distDir, outputDir }));
  assert.equal(await readFile(resolve(outputDir, "index.html"), "utf8"), previous);
});
