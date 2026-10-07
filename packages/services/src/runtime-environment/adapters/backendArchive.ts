import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, rename, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "@lcode/shared/node";
import {
  backendExecutableName,
  backendPlatformKey,
  isPathWithin,
  type BackendPlatform,
} from "./backendPlatform.js";
import { extractTarXzArchive, extractZipArchive } from "./backendArchiveExtract.js";

const MAX_ASSET_BYTES = 512 * 1024 * 1024;

export const MISE_BACKEND_VERSION = "v2026.10.2";

export const MISE_ASSET_DIGESTS: Readonly<Record<string, string>> = {
  "windows-x64": "6ce4281dc65a4dc22de2aed42db5e8859293a467964763b43fcc33fa0e6c4214",
  "windows-arm64": "9c4abb29dc88d956f5d6f2e468bade7843c9e3242690a9dbb22b2bbac4d007be",
  "macos-x64": "b8b23b39a05f1b36ebb49c5c556d549585f7e4b2d05ba9ff7c09bb026bf0fca7",
  "macos-arm64": "11df20cfebb7f52eb5c6f68c367eadc6cf22aca169566a8f5b2fa92bf1564540",
  "linux-x64": "a5f2082b6694c6f27e6a528e55dfb5983998a4d73004d003dfbf03406b938d49",
  "linux-x64-musl": "e35412ea4e944f959cccfa5826d6f860a08417a00dc023579cab3561c5a72fa3",
  "linux-arm64": "2df2ecffe694802cae43865fe11b932db361a902b7d4c4726fb4aaaa2d6a2396",
  "linux-arm64-musl": "32d89cc197a92016c7285c4fbdf067919b44097b7da65ff5722a3bc55b1cf793",
};

export const MISE_ASSETS: Readonly<Record<string, string>> = {
  "windows-x64": "mise-v2026.10.2-windows-x64.zip",
  "windows-arm64": "mise-v2026.10.2-windows-arm64.zip",
  "macos-x64": "mise-v2026.10.2-macos-x64.tar.xz",
  "macos-arm64": "mise-v2026.10.2-macos-arm64.tar.xz",
  "linux-x64": "mise-v2026.10.2-linux-x64.tar.xz",
  "linux-x64-musl": "mise-v2026.10.2-linux-x64-musl.tar.xz",
  "linux-arm64": "mise-v2026.10.2-linux-arm64.tar.xz",
  "linux-arm64-musl": "mise-v2026.10.2-linux-arm64-musl.tar.xz",
};

export interface BackendManifest {
  version: string;
  platform: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface BundledBackendTarget {
  version?: string;
  platform: BackendPlatform;
  archiveSha256?: string;
  binarySha256?: string;
}

export interface ValidatedBundledBackend {
  backendPath: string;
  manifestPath: string;
  manifest: BackendManifest;
}

export interface BackendDownloadOptions {
  platform: BackendPlatform;
  destinationRoot: string;
  /** Optional archive cache. A cached file is accepted only after the fixed SHA-256 check. */
  cacheRoot?: string;
  /** Sibling staging parent. Defaults to the fixed version directory. */
  stagingRoot?: string;
  /** Must match the fixed official asset name for the target platform. */
  assetName?: string;
  /** Must match the fixed official archive digest for the target platform. */
  expectedArchiveSha256?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  fetchTimeoutMs?: number;
}

export function requiredBackendMembers(platform: BackendPlatform): readonly string[] {
  return [
    `mise/bin/${backendExecutableName(platform)}`,
    ...(platform.platform === "win32" ? ["mise/bin/mise-shim.exe"] : []),
    "mise/LICENSE",
    "mise/README.md",
  ];
}

function manifestPathFor(root: string): string {
  return join(resolve(root), "backend-manifest.json");
}

function binaryPathFor(root: string, platform: BackendPlatform): string {
  return join(resolve(root), "bin", backendExecutableName(platform));
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid ${label} sha256 in backend manifest`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

export async function validateBundledBackend(
  root: string,
  target: BundledBackendTarget,
): Promise<ValidatedBundledBackend> {
  const resolvedRoot = resolve(root);
  const canonicalRoot = await realpath(resolvedRoot);
  const platformKey = backendPlatformKey(target.platform);
  const manifestPath = manifestPathFor(resolvedRoot);
  const backendPath = binaryPathFor(resolvedRoot, target.platform);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`bundled mise manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("bundled mise manifest is not an object");
  const manifest = parsed as Partial<BackendManifest>;
  if (
    typeof manifest.version !== "string" ||
    typeof manifest.platform !== "string" ||
    typeof manifest.archiveSha256 !== "string" ||
    typeof manifest.binarySha256 !== "string"
  ) {
    throw new Error("bundled mise manifest is missing required fields");
  }
  assertDigest(manifest.archiveSha256, "archive");
  assertDigest(manifest.binarySha256, "binary");
  if (manifest.version !== (target.version ?? MISE_BACKEND_VERSION)) {
    throw new Error(`bundled mise manifest version mismatch: ${manifest.version}`);
  }
  if (manifest.platform !== platformKey) {
    throw new Error(`bundled mise manifest platform mismatch: ${manifest.platform}`);
  }
  if (target.archiveSha256 && manifest.archiveSha256 !== target.archiveSha256) {
    throw new Error("bundled mise archive digest mismatch");
  }
  if (target.binarySha256 && manifest.binarySha256 !== target.binarySha256) {
    throw new Error("bundled mise binary digest mismatch");
  }

  for (const member of requiredBackendMembers(target.platform)) {
    const relativePath = member.slice("mise/".length);
    const filePath = resolve(resolvedRoot, relativePath);
    const info = await lstat(filePath);
    if (!info.isFile()) throw new Error(`bundled mise member is not a regular file: ${relativePath}`);
    const canonical = await realpath(filePath);
    if (!isPathWithin(canonicalRoot, canonical)) throw new Error(`bundled mise member escapes root: ${relativePath}`);
  }
  const binarySha256 = await sha256File(backendPath);
  if (binarySha256 !== manifest.binarySha256) {
    throw new Error("bundled mise binary digest does not match manifest");
  }
  return { backendPath, manifestPath, manifest: manifest as BackendManifest };
}

export async function downloadAndPublishBackend(options: BackendDownloadOptions): Promise<string> {
  const key = backendPlatformKey(options.platform);
  const fixedAssetName = MISE_ASSETS[key];
  const fixedDigest = MISE_ASSET_DIGESTS[key];
  if (!fixedAssetName || !fixedDigest) throw new Error(`no fixed mise asset for ${key}`);
  if (options.assetName !== undefined && options.assetName !== fixedAssetName) {
    throw new Error(`mise asset name is not fixed for ${key}`);
  }
  if (options.expectedArchiveSha256 !== undefined && options.expectedArchiveSha256 !== fixedDigest) {
    throw new Error(`mise asset digest is not fixed for ${key}`);
  }

  const destinationRoot = resolve(options.destinationRoot);
  const finalDir = join(destinationRoot, MISE_BACKEND_VERSION, key);
  const versionRoot = dirname(finalDir);
  await mkdir(versionRoot, { recursive: true });

  return withFileLock(join(versionRoot, `${key}.publish`), async () => {
    try {
      return (
        await validateBundledBackend(finalDir, {
          version: MISE_BACKEND_VERSION,
          platform: options.platform,
          archiveSha256: fixedDigest,
        })
      ).backendPath;
    } catch {
      await rm(finalDir, { recursive: true, force: true });
    }

    const stagingParent = resolve(options.stagingRoot ?? versionRoot);
    await mkdir(stagingParent, { recursive: true });
    const staging = await mkdtemp(join(stagingParent, `.staging-${process.pid}-`));
    const archivePath = join(staging, fixedAssetName);
    const payload = join(staging, "payload");
    const url = `https://github.com/jdx/mise/releases/download/${MISE_BACKEND_VERSION}/${fixedAssetName}`;

    try {
      const cachedArchive = options.cacheRoot ? join(resolve(options.cacheRoot), fixedAssetName) : undefined;
      if (cachedArchive) {
        await mkdir(dirname(cachedArchive), { recursive: true });
        const cachedDigest = await sha256File(cachedArchive).catch(() => undefined);
        if (cachedDigest !== fixedDigest) {
          await rm(cachedArchive, { force: true });
          await downloadBounded(url, cachedArchive, options);
          const downloadedDigest = await sha256File(cachedArchive);
          if (downloadedDigest !== fixedDigest) {
            await rm(cachedArchive, { force: true });
            throw new Error(`mise asset digest mismatch: got ${downloadedDigest}, want ${fixedDigest}`);
          }
        }
        await copyFile(cachedArchive, archivePath);
      } else {
        await downloadBounded(url, archivePath, options);
      }
      const digest = await sha256File(archivePath);
      if (digest !== fixedDigest) throw new Error(`mise asset digest mismatch: got ${digest}, want ${fixedDigest}`);

      await mkdir(payload, { recursive: true });
      await extractBackendArchive(archivePath, payload, options.platform, fixedAssetName);
      const binarySha256 = await sha256File(binaryPathFor(payload, options.platform));
      const manifest: BackendManifest = {
        version: MISE_BACKEND_VERSION,
        platform: key,
        archiveSha256: digest,
        binarySha256,
      };
      await writeFile(manifestPathFor(payload), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await validateBundledBackend(payload, {
        version: MISE_BACKEND_VERSION,
        platform: options.platform,
        archiveSha256: fixedDigest,
        binarySha256,
      });
      await rename(payload, finalDir);
      return binaryPathFor(finalDir, options.platform);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function extractBackendArchive(
  archivePath: string,
  destinationDir: string,
  platform: BackendPlatform,
  assetName = archivePath,
): Promise<void> {
  const destination = resolve(destinationDir);
  await mkdir(destination, { recursive: true });
  const required = requiredBackendMembers(platform);
  if (assetName.toLowerCase().endsWith(".zip")) {
    await extractZipArchive(archivePath, destination, required);
  } else if (assetName.toLowerCase().endsWith(".tar.xz")) {
    await extractTarXzArchive(archivePath, destination, required);
  } else {
    throw new Error(`unsupported mise archive extension: ${assetName}`);
  }
  for (const member of required) {
    const relativePath = member.slice("mise/".length);
    const target = resolve(destination, relativePath);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`required backend member is not a regular file: ${member}`);
    const canonical = await realpath(target);
    if (!isPathWithin(destination, canonical)) throw new Error(`extracted backend member redirects outside: ${member}`);
  }
}

async function downloadBounded(
  url: string,
  destination: string,
  options: BackendDownloadOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.fetchTimeoutMs ?? 600_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, { signal });
  if (!response.ok || !response.body) throw new Error(`mise asset download failed: HTTP ${response.status}`);
  const output = await open(destination, "w");
  let bytes = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_ASSET_BYTES) throw new Error(`mise asset exceeds ${MAX_ASSET_BYTES} byte limit`);
      await output.write(buffer);
    }
  } finally {
    await output.close();
  }
}
