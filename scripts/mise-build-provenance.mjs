import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");

export function resolveMiseCacheDir(cacheDir) {
  return resolve(
    cacheDir ?? process.env.LCODE_MISE_CACHE_DIR ?? join(workspaceRoot, ".cache", "mise"),
  );
}

export async function validateMiseBuildProvenance({ root, target, backendApi: api, cacheDir }) {
  const assetName = api.MISE_ASSETS[target.backendKey];
  const expected = api.MISE_ASSET_DIGESTS[target.backendKey];
  if (!assetName || !expected) throw new Error(`No fixed mise archive for ${target.backendKey}`);
  const cacheRoot = resolveMiseCacheDir(cacheDir);
  const cachedArchive = join(cacheRoot, assetName);
  // 修复：自报 archiveSha256 的 manifest 不能证明二进制来自该归档；签名和复用前都比对固定归档原文。
  const archiveInfo = await lstat(cachedArchive).catch((error) => {
    throw new Error(`Missing fixed mise archive provenance: ${cachedArchive}`, { cause: error });
  });
  if (!archiveInfo.isFile()) throw new Error("Fixed mise archive must be a regular file");
  const staging = await mkdtemp(join(cacheRoot, `.mise-provenance-${process.pid}-`));
  try {
    const archive = join(staging, assetName);
    await copyFile(cachedArchive, archive);
    if ((await api.sha256File(archive)) !== expected)
      throw new Error("Fixed mise archive digest mismatch");
    const extracted = join(staging, "original");
    await api.extractBackendArchive(archive, extracted, target.backendPlatform, assetName);
    for (const member of api.requiredBackendMembers(target.backendPlatform)) {
      const relative = member.slice("mise/".length);
      if (
        (await api.sha256File(join(root, relative))) !==
        (await api.sha256File(join(extracted, relative)))
      ) {
        throw new Error(`mise fixed archive provenance mismatch: ${relative}`);
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
