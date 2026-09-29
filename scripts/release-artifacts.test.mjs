import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { expectedArtifactNames, stageReleaseArtifacts } from "./stage-release-artifacts.mjs";

test("six native targets get exact architecture and version artifacts", async () => {
  const targets = [
    ["mac", "x64", 3],
    ["mac", "arm64", 3],
    ["win", "x64", 2],
    ["win", "arm64", 2],
    ["linux", "x64", 5],
    // 上游 electron-builder 不生成时，staging 仍必须补齐 Linux arm64 更新清单。
    ["linux", "arm64", 5],
  ];
  for (const [os, arch, count] of targets) {
    assert.equal(expectedArtifactNames("3.14.2", os, arch).length, count);
  }
  assert.deepEqual(expectedArtifactNames("3.14.2", "linux", "x64"), [
    "LCode-3.14.2-linux-x86_64.AppImage",
    "LCode-3.14.2-linux-amd64.deb",
    "LCode-3.14.2-linux-x86_64.rpm",
    "LCode-3.14.2-linux-x64.pkg.tar.zst",
    "latest-linux-x64.yml",
  ]);
  assert.deepEqual(expectedArtifactNames("3.14.2", "linux", "arm64"), [
    "LCode-3.14.2-linux-arm64.AppImage",
    "LCode-3.14.2-linux-arm64.deb",
    "LCode-3.14.2-linux-aarch64.rpm",
    "LCode-3.14.2-linux-aarch64.pkg.tar.zst",
    "latest-linux-arm64.yml",
  ]);
  assert.deepEqual(expectedArtifactNames("3.14.2", "win", "x64"), [
    "LCode-3.14.2-win-x64.exe",
    "latest-win-x64.yml",
  ]);

  const directory = await mkdtemp(join(tmpdir(), "lcode-release-assets-"));
  try {
    const distDir = join(directory, "dist");
    const outputDir = join(directory, "out");
    await mkdir(distDir);
    const macNames = expectedArtifactNames("3.14.2", "mac", "arm64");
    const macInstallers = macNames.slice(0, 2);
    for (const name of macNames) await writeFile(join(distDir, name), name);
    await writeFile(
      join(distDir, "latest-mac.yml"),
      YAML.stringify({
        version: "3.14.2",
        files: macInstallers.map((url) => ({ url, sha512: "stale", size: 0 })),
        path: macInstallers[1],
        sha512: "stale",
        releaseName: "preserved",
      }),
    );
    await writeFile(join(distDir, "LCode-3.14.1-mac-arm64.dmg"), "old");
    await writeFile(join(distDir, "LCode-3.14.2-mac-x64.dmg"), "wrong arch");
    const names = await stageReleaseArtifacts({
      version: "3.14.2",
      os: "mac",
      arch: "arm64",
      distDir,
      outputDir,
    });
    assert.deepEqual(names, expectedArtifactNames("3.14.2", "mac", "arm64"));
    assert.deepEqual(await readFile(join(outputDir, names[0]), "utf8"), names[0]);
    // 最终清单保留上游字段，但摘要必须以完成内签/重打包后的最终字节重算。
    const manifest = YAML.parse(await readFile(join(outputDir, "latest-mac-arm64.yml"), "utf8"));
    assert.equal(manifest.releaseName, "preserved");
    assert.equal(manifest.path, "LCode-3.14.2-mac-arm64.zip");
    for (const file of manifest.files) {
      assert.equal(file.size, file.url.length);
      assert.equal(file.sha512, createHash("sha512").update(file.url).digest("base64"));
    }
    assert.equal(manifest.sha512, manifest.files[1].sha512);
    await assert.rejects(
      stageReleaseArtifacts({ version: "3.14.2", os: "win", arch: "x64", distDir, outputDir }),
      /missing.*win-x64/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
