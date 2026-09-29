import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";

export interface UpdateArtifactManifestFile {
  url?: string | null;
  sha512?: string | null;
  size?: number | null;
}

export interface UpdateArtifactManifestLike {
  files?: Array<UpdateArtifactManifestFile | null> | null;
  lcodeManifestBaseUrl?: string | null;
  lcodeInstallExtensions?: readonly string[] | null;
}

export interface VerifiedUpdateArtifact {
  url: string;
  fileName: string;
  sha512: string;
  size: number;
}

interface UpdateArtifactResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array> | null;
}

export type UpdateArtifactFetch = (
  url: string,
  options: { signal?: AbortSignal },
) => Promise<UpdateArtifactResponse>;

export function resolveUpdateInstallExtensions(
  platform: NodeJS.Platform,
  linuxExtensions: readonly string[] | null,
): readonly string[] {
  if (platform === "win32") return [".exe"];
  if (platform === "darwin") return [".dmg"];
  if (platform === "linux" && linuxExtensions?.length) return linuxExtensions;
  throw new Error(`Unsupported desktop update install format: ${platform}`);
}

function normalizeSha512(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw new Error("Update artifact is missing a valid SHA-512 checksum");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== normalized) {
    throw new Error("Update artifact is missing a valid SHA-512 checksum");
  }
  return normalized;
}

function normalizeInstallExtensions(values: readonly string[] | null | undefined): string[] {
  const extensions = (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^\.[a-z0-9.]+$/u.test(value));
  if (extensions.length === 0) {
    throw new Error("Update manifest has no current install format");
  }
  return [...new Set(extensions)];
}

function resolveArtifactUrl(value: string, baseUrl: string | null | undefined): URL {
  let url: URL;
  try {
    url = new URL(value, baseUrl?.trim() || undefined);
  } catch {
    throw new Error("Update artifact URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Update artifact URL must use HTTP or HTTPS");
  }
  return url;
}

function readArtifactFileName(url: URL, extensions: readonly string[]): string {
  let fileName: string;
  try {
    fileName = posix.basename(decodeURIComponent(url.pathname));
  } catch {
    throw new Error("Update artifact filename is invalid");
  }
  const normalized = fileName.toLowerCase();
  if (!fileName || !extensions.some((extension) => normalized.endsWith(extension))) {
    throw new Error("Update manifest contains no artifact for the current install format");
  }
  return fileName;
}

export function selectVerifiedUpdateArtifact(
  manifest: UpdateArtifactManifestLike,
): VerifiedUpdateArtifact {
  const extensions = normalizeInstallExtensions(manifest.lcodeInstallExtensions);
  const candidate = manifest.files?.find((file) => {
    if (typeof file?.url !== "string") return false;
    try {
      const pathname = resolveArtifactUrl(
        file.url,
        manifest.lcodeManifestBaseUrl,
      ).pathname.toLowerCase();
      return extensions.some((extension) => pathname.endsWith(extension));
    } catch {
      return false;
    }
  });
  if (!candidate?.url) {
    throw new Error("Update manifest contains no artifact for the current install format");
  }

  const url = resolveArtifactUrl(candidate.url, manifest.lcodeManifestBaseUrl);
  const size = candidate.size;
  if (!Number.isSafeInteger(size) || Number(size) <= 0) {
    throw new Error("Update artifact is missing a valid size");
  }
  return {
    url: url.href,
    fileName: readArtifactFileName(url, extensions),
    sha512: normalizeSha512(candidate.sha512),
    size: Number(size),
  };
}

async function calculateFileSha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

async function isVerifiedCachedFile(
  path: string,
  artifact: VerifiedUpdateArtifact,
): Promise<boolean> {
  const file = await stat(path).catch(() => null);
  if (!file?.isFile() || file.size !== artifact.size) return false;
  return (await calculateFileSha512(path)) === artifact.sha512;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("cancelled");
}

export async function downloadVerifiedUpdateArtifact(options: {
  artifact: VerifiedUpdateArtifact;
  directory: string;
  fetcher: UpdateArtifactFetch;
  signal?: AbortSignal;
  onProgress?: (transferredBytes: number, totalBytes: number) => void;
}): Promise<string> {
  const { artifact, fetcher, signal, onProgress } = options;
  await mkdir(options.directory, { recursive: true });
  const destination = resolve(options.directory, artifact.fileName);
  if (await isVerifiedCachedFile(destination, artifact)) {
    onProgress?.(artifact.size, artifact.size);
    return destination;
  }
  await rm(destination, { force: true });

  throwIfCancelled(signal);
  const response = await fetcher(artifact.url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `Update artifact download failed: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  const hash = createHash("sha512");
  let transferredBytes = 0;
  try {
    try {
      for await (const value of response.body) {
        throwIfCancelled(signal);
        const chunk = Buffer.from(value);
        if (transferredBytes + chunk.length > artifact.size) {
          // 功能原因：manifest 已给出最终字节数时立即限制写入，避免异常响应持续占满更新缓存。
          throw new Error(
            `Update artifact size mismatch: expected ${artifact.size}, received more bytes`,
          );
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error("Update artifact write made no progress");
          offset += bytesWritten;
        }
        transferredBytes += chunk.length;
        onProgress?.(transferredBytes, artifact.size);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfCancelled(signal);
    if (transferredBytes !== artifact.size) {
      throw new Error(
        `Update artifact size mismatch: expected ${artifact.size}, received ${transferredBytes}`,
      );
    }
    if (hash.digest("base64") !== artifact.sha512) {
      throw new Error("Update artifact SHA-512 checksum mismatch");
    }
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}
