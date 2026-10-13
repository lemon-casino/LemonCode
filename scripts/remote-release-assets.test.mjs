import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packSourceAsDeterministicTarGzip } from "./deterministic-tar-archive.mjs";
import { remoteMisePlatforms } from "./prepare-remote-mise-assets.mjs";
import {
  stageRemoteReleaseAssets,
  verifyRemoteReleaseAssets,
} from "./stage-remote-release-assets.mjs";
import { createRemoteReleaseFixture } from "./remote-release-assets.fixture.mjs";
import { expectedArtifactNames, verifyCollectedArtifacts } from "./stage-release-artifacts.mjs";

const version = "9.8.7";

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "lcode-remote-release-"));
  try {
    await run({ root, ...(await createRemoteReleaseFixture(root)), outputDir: join(root, "out") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("four remote platforms stage flat assets that preserve mount, versions and SHA", async () => {
  await withFixture(async (options) => {
    const names = await stageRemoteReleaseAssets(options);
    assert.deepEqual((await readdir(options.outputDir)).sort(), names.toSorted());
    assert.deepEqual(
      await verifyRemoteReleaseAssets({ version, directory: options.outputDir }),
      names,
    );
    for (const platform of remoteMisePlatforms) {
      const original = JSON.parse(
        await readFile(
          join(options.sourceDir, "releases", version, `manifest-${platform}.json`),
          "utf8",
        ),
      );
      const staged = JSON.parse(
        await readFile(join(options.outputDir, `manifest-${platform}.json`), "utf8"),
      );
      assert.equal(staged.appVersion, version);
      for (const [index, component] of staged.components.entries()) {
        const source = original.components[index];
        assert.deepEqual({ ...component, artifactPath: source.artifactPath }, source);
        assert.match(
          component.artifactPath,
          new RegExp(`^remote-${platform}-${component.id}-${component.sha256}\\.tar\\.gz$`),
        );
        assert.deepEqual(
          await readFile(join(options.outputDir, component.artifactPath)),
          await readFile(join(options.sourceDir, source.artifactPath)),
        );
      }
    }
  });
});

for (const [label, mutate, error] of [
  [
    "wrong schema",
    (m) => {
      m.schemaVersion = 2;
    },
    /schema/i,
  ],
  [
    "wrong app version",
    (m) => {
      m.appVersion = "9.8.6";
    },
    /version/i,
  ],
  [
    "wrong platform",
    (m) => {
      m.platformArch = "darwin-x64";
    },
    /platform/i,
  ],
  [
    "missing component",
    (m) => {
      m.components.pop();
    },
    /missing component/i,
  ],
  [
    "duplicate component",
    (m) => {
      m.components.push(m.components[0]);
    },
    /duplicate/i,
  ],
  [
    "wrong mount",
    (m) => {
      m.components[0].mount = "glm/linux-x64";
    },
    /mount/i,
  ],
  [
    "escaping artifact path",
    (m) => {
      m.components[0].artifactPath = "../outside.tar.gz";
    },
    /path/i,
  ],
  [
    "wrong SHA",
    (m) => {
      m.components[0].sha256 = "a".repeat(64);
    },
    /SHA/i,
  ],
]) {
  test(`remote release staging rejects ${label} before creating output`, async () => {
    await withFixture(async (options) => {
      const path = join(options.sourceDir, "releases", version, "manifest-linux-x64.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      mutate(manifest);
      await writeFile(path, JSON.stringify(manifest));
      await assert.rejects(stageRemoteReleaseAssets(options), error);
      await assert.rejects(readdir(options.outputDir), { code: "ENOENT" });
    });
  });
}

test("missing manifest and archive prevent publication", async () => {
  await withFixture(async (options) => {
    const path = join(options.sourceDir, "releases", version, "manifest-linux-x64.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await rm(join(options.sourceDir, manifest.components[0].artifactPath));
    await assert.rejects(stageRemoteReleaseAssets(options), /archive/i);
    await rm(path);
    await assert.rejects(stageRemoteReleaseAssets(options), /manifest/i);
  });
});

test("valid SHA cannot conceal an archive missing the required server entry", async () => {
  await withFixture(async (options) => {
    const path = join(options.sourceDir, "releases", version, "manifest-linux-x64.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const component = manifest.components.find((c) => c.id === "server-bundle");
    const source = join(options.root, "incomplete");
    await mkdir(source);
    await writeFile(join(source, "README.md"), "incomplete");
    const archivePath = join(options.sourceDir, component.artifactPath);
    packSourceAsDeterministicTarGzip(source, archivePath);
    component.sha256 = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(stageRemoteReleaseAssets(options), /required.*lcode-server\.cjs/i);
  });
});

test("collected release verification rejects a removed or corrupt referenced archive", async () => {
  await withFixture(async (options) => {
    await stageRemoteReleaseAssets(options);
    const manifest = JSON.parse(
      await readFile(join(options.outputDir, "manifest-linux-x64.json"), "utf8"),
    );
    const path = join(options.outputDir, manifest.components[0].artifactPath);
    await writeFile(path, "corrupt");
    await assert.rejects(
      verifyRemoteReleaseAssets({ version, directory: options.outputDir }),
      /SHA/i,
    );
    await rm(path);
    await assert.rejects(
      verifyRemoteReleaseAssets({ version, directory: options.outputDir }),
      /archive/i,
    );
  });
});

test("the publication gate rejects desktop-only assets and accepts the complete combined release", async () => {
  await withFixture(async (options) => {
    await mkdir(options.outputDir);
    const installers = ["mac", "win", "linux"].flatMap((os) =>
      ["x64", "arm64"].flatMap((arch) => expectedArtifactNames(version, os, arch)),
    );
    for (const name of installers) await writeFile(join(options.outputDir, name), name);
    await assert.rejects(
      verifyCollectedArtifacts({ version, directory: options.outputDir, remoteAssets: true }),
      /manifest/i,
    );
    const remoteNames = await stageRemoteReleaseAssets(options);
    for (const name of installers) await writeFile(join(options.outputDir, name), name);
    const complete = await verifyCollectedArtifacts({
      version,
      directory: options.outputDir,
      remoteAssets: true,
    });
    assert.equal(complete.length, installers.length + remoteNames.length);
    await writeFile(join(options.outputDir, "remote-stale.tar.gz"), "stale");
    await assert.rejects(
      verifyCollectedArtifacts({ version, directory: options.outputDir, remoteAssets: true }),
      /extra/i,
    );
  });
});
