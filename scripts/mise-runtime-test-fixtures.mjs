import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBackendArchiveApi } from "../packages/desktop/scripts/prepare-mise-runtime-assets.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function miseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lcode-mise-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realApi = await loadBackendArchiveApi();
  const cacheDir = join(root, "cache");
  const calls = { publish: 0, extract: 0 };
  const keyFor = (platform) =>
    `${platform.platform === "win32" ? "windows" : platform.platform === "darwin" ? "macos" : "linux"}-${platform.arch}${platform.libc === "musl" ? "-musl" : ""}`;
  const archiveBytes = (key) => Buffer.from(`fixed archive fixture ${key}\n`);
  const binaryBytes = (key) => Buffer.from(`original binary fixture ${key}\n`);
  const api = {
    ...realApi,
    MISE_ASSET_DIGESTS: Object.fromEntries(
      Object.keys(realApi.MISE_ASSET_DIGESTS).map((key) => [key, digest(archiveBytes(key))]),
    ),
    async extractBackendArchive(_archivePath, destination, platform) {
      calls.extract += 1;
      const key = keyFor(platform);
      await mkdir(join(destination, "bin"), { recursive: true });
      for (const member of realApi.requiredBackendMembers(platform)) {
        const relativePath = member.slice("mise/".length);
        const bytes =
          relativePath === `bin/${platform.platform === "win32" ? "mise.exe" : "mise"}`
            ? binaryBytes(key)
            : Buffer.from(`fixture ${relativePath}\n`);
        await writeFile(join(destination, relativePath), bytes);
        if (relativePath.startsWith("bin/")) await chmod(join(destination, relativePath), 0o755);
      }
    },
    async downloadAndPublishBackend({ platform, destinationRoot, cacheRoot }) {
      calls.publish += 1;
      const key = keyFor(platform);
      await mkdir(cacheRoot, { recursive: true });
      const archivePath = join(cacheRoot, realApi.MISE_ASSETS[key]);
      await writeFile(archivePath, archiveBytes(key));
      const destination = join(destinationRoot, realApi.MISE_BACKEND_VERSION, key);
      await api.extractBackendArchive(archivePath, destination, platform);
      await writeFile(
        join(destination, "backend-manifest.json"),
        `${JSON.stringify(
          {
            version: realApi.MISE_BACKEND_VERSION,
            platform: key,
            archiveSha256: api.MISE_ASSET_DIGESTS[key],
            binarySha256: digest(binaryBytes(key)),
          },
          null,
          2,
        )}\n`,
      );
      return join(destination, "bin", platform.platform === "win32" ? "mise.exe" : "mise");
    },
  };
  return { root, cacheDir, api, calls, binaryBytes };
}
