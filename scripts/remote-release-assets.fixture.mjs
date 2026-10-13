import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildRemoteComponentDefinitions,
  buildRemoteComponentRequiredPaths,
} from "./prepare-prebuilds.mjs";
import { packSourceAsDeterministicTarGzip } from "./deterministic-tar-archive.mjs";
import { remoteMisePlatforms } from "./prepare-remote-mise-assets.mjs";

export async function createRemoteReleaseFixture(root, version = "9.8.7") {
  const sourceDir = join(root, "mock-cdn");
  for (const platform of remoteMisePlatforms) {
    const components = [];
    for (const definition of buildRemoteComponentDefinitions(platform)) {
      const sourcePath = join(root, "sources", platform, definition.id);
      for (const member of buildRemoteComponentRequiredPaths(definition.id, platform)) {
        const path = join(sourcePath, member);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${platform}/${definition.id}/${member}`);
      }
      const artifactPath = `components/${platform}/${definition.id}/v1.tar.gz`;
      const archivePath = join(sourceDir, artifactPath);
      await mkdir(dirname(archivePath), { recursive: true });
      packSourceAsDeterministicTarGzip(sourcePath, archivePath);
      components.push({
        id: definition.id,
        version: "v1",
        mount: definition.mount,
        artifactPath,
        sha256: createHash("sha256")
          .update(await readFile(archivePath))
          .digest("hex"),
      });
    }
    const manifestPath = join(sourceDir, "releases", version, `manifest-${platform}.json`);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, appVersion: version, platformArch: platform, components }),
    );
  }
  return { sourceDir, version };
}
