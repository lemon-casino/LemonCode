import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { verifyReleaseVersion } from "./verify-release-version.mjs";
import {
  expectedArtifactNames,
  stageReleaseArtifacts,
  verifyCollectedArtifacts,
} from "./stage-release-artifacts.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("release tag must match the packaged version", () => {
  assert.equal(
    verifyReleaseVersion({ refType: "tag", refName: "v3.14.2", version: "3.14.2" }),
    "3.14.2",
  );
  assert.equal(
    verifyReleaseVersion({ refType: "branch", refName: "main", version: "3.14.2" }),
    "3.14.2",
  );
  assert.throws(
    () => verifyReleaseVersion({ refType: "tag", refName: "v3.14.3", version: "3.14.2" }),
    /tag.*version/iu,
  );
  assert.throws(
    () => verifyReleaseVersion({ refType: "tag", refName: "v3.14.2-rc.1", version: "3.14.2" }),
    /tag.*version/iu,
  );
});

test("six native targets get exact architecture and version artifacts", async () => {
  const targets = [
    ["mac", "x64", 2],
    ["mac", "arm64", 2],
    ["win", "x64", 1],
    ["win", "arm64", 1],
    ["linux", "x64", 4],
    ["linux", "arm64", 4],
  ];
  for (const [os, arch, count] of targets) {
    assert.equal(expectedArtifactNames("3.14.2", os, arch).length, count);
  }
  assert.deepEqual(expectedArtifactNames("3.14.2", "linux", "x64"), [
    "ZCode-3.14.2-linux-x86_64.AppImage",
    "ZCode-3.14.2-linux-amd64.deb",
    "ZCode-3.14.2-linux-x86_64.rpm",
    "ZCode-3.14.2-linux-x64.pkg.tar.zst",
  ]);
  assert.deepEqual(expectedArtifactNames("3.14.2", "linux", "arm64"), [
    "ZCode-3.14.2-linux-arm64.AppImage",
    "ZCode-3.14.2-linux-arm64.deb",
    "ZCode-3.14.2-linux-aarch64.rpm",
    "ZCode-3.14.2-linux-aarch64.pkg.tar.zst",
  ]);

  const directory = await mkdtemp(join(tmpdir(), "zcode-release-assets-"));
  try {
    const distDir = join(directory, "dist");
    const outputDir = join(directory, "out");
    await mkdir(distDir);
    for (const name of expectedArtifactNames("3.14.2", "mac", "arm64")) {
      await writeFile(join(distDir, name), name);
    }
    await writeFile(join(distDir, "ZCode-3.14.1-mac-arm64.dmg"), "old");
    await writeFile(join(distDir, "ZCode-3.14.2-mac-x64.dmg"), "wrong arch");
    const names = await stageReleaseArtifacts({
      version: "3.14.2",
      os: "mac",
      arch: "arm64",
      distDir,
      outputDir,
    });
    assert.deepEqual(names, expectedArtifactNames("3.14.2", "mac", "arm64"));
    assert.deepEqual(await readFile(join(outputDir, names[0]), "utf8"), names[0]);
    await assert.rejects(
      stageReleaseArtifacts({ version: "3.14.2", os: "win", arch: "x64", distDir, outputDir }),
      /missing.*win-x64/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux staging requires each native package name for its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-linux-release-"));
  try {
    const distDir = join(directory, "dist");
    await mkdir(distDir);
    const names = [
      "ZCode-3.14.2-linux-x86_64.AppImage",
      "ZCode-3.14.2-linux-amd64.deb",
      "ZCode-3.14.2-linux-x86_64.rpm",
      "ZCode-3.14.2-linux-x64.pkg.tar.zst",
      "ZCode-3.14.2-linux-arm64.AppImage",
      "ZCode-3.14.2-linux-arm64.deb",
      "ZCode-3.14.2-linux-aarch64.rpm",
      "ZCode-3.14.2-linux-aarch64.pkg.tar.zst",
    ];
    for (const name of names) await writeFile(join(distDir, name), name);
    for (const arch of ["x64", "arm64"]) {
      const outputDir = join(directory, arch);
      const staged = await stageReleaseArtifacts({
        version: "3.14.2",
        os: "linux",
        arch,
        distDir,
        outputDir,
      });
      assert.deepEqual(staged, expectedArtifactNames("3.14.2", "linux", arch));
      assert.deepEqual((await readdir(outputDir)).sort(), staged.toSorted());
    }
    await rm(join(distDir, "ZCode-3.14.2-linux-x86_64.AppImage"));
    await writeFile(join(distDir, "ZCode-3.14.2-linux-x64.AppImage"), "legacy name");
    await assert.rejects(
      stageReleaseArtifacts({
        version: "3.14.2",
        os: "linux",
        arch: "x64",
        distDir,
        outputDir: join(directory, "invalid"),
      }),
      /missing.*linux-x86_64\.AppImage/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Actions builds every supported platform and publishes only completed tag builds", async () => {
  const workflow = YAML.parse(
    await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8"),
  );
  const include = workflow.jobs.build.strategy.matrix.include;
  assert.deepEqual(
    new Set(include.map(({ os, arch }) => `${os}-${arch}`)),
    new Set(["mac-x64", "mac-arm64", "win-x64", "win-arm64", "linux-x64", "linux-arm64"]),
  );
  assert.equal(
    include.find(({ os, arch }) => os === "mac" && arch === "x64").runner,
    "macos-15-intel",
  );
  assert.equal(include.find(({ os, arch }) => os === "mac" && arch === "arm64").runner, "macos-15");
  assert.deepEqual(workflow.on.push.tags, ["v*"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.equal(workflow.jobs.release.needs, "build");
  assert.match(workflow.jobs.release.if, /github\.ref_type == 'tag'/u);
  assert.equal(workflow.jobs.release.permissions.contents, "write");
  assert.equal(workflow.jobs.build.permissions.contents, "read");
  const releaseSteps = workflow.jobs.release.steps;
  assert.ok(
    releaseSteps.findIndex((step) => step.name === "Verify release notices") <
      releaseSteps.findIndex((step) => step.name === "Publish verified release"),
  );
});

test("release rejects missing or unexpected platform installers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-complete-release-"));
  try {
    for (const os of ["mac", "win", "linux"]) {
      for (const arch of ["x64", "arm64"]) {
        for (const name of expectedArtifactNames("3.14.2", os, arch)) {
          await writeFile(join(directory, name), name);
        }
      }
    }
    assert.equal((await verifyCollectedArtifacts({ version: "3.14.2", directory })).length, 14);
    await writeFile(join(directory, "ZCode-3.14.1-win-x64.exe"), "stale");
    await assert.rejects(
      verifyCollectedArtifacts({ version: "3.14.2", directory }),
      /extra.*3\.14\.1/iu,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
