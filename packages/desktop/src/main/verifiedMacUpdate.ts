import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { posix, resolve } from "node:path";

export interface MacUpdateManifestFile {
  url?: string | null;
  sha512?: string | null;
  size?: number | null;
}

export interface MacUpdateManifestLike {
  files?: Array<MacUpdateManifestFile | null> | null;
  lcodeManifestBaseUrl?: string | null;
}

export interface VerifiedMacDmgArtifact {
  url: string;
  fileName: string;
  sha512: string;
  size?: number;
}

interface MacUpdateResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array> | null;
  headers: { get(name: string): string | null };
}

export type MacUpdateFetch = (
  url: string,
  options: { signal?: AbortSignal },
) => Promise<MacUpdateResponse>;

function normalizeSha512(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized)) {
    throw new Error("macOS update DMG is missing a valid SHA-512 checksum");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== normalized) {
    throw new Error("macOS update DMG is missing a valid SHA-512 checksum");
  }
  return normalized;
}

function resolveDmgUrl(value: string, baseUrl: string | null | undefined): URL {
  let url: URL;
  try {
    url = new URL(value, baseUrl?.trim() || undefined);
  } catch {
    throw new Error("macOS update DMG URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("macOS update DMG URL must use HTTP or HTTPS");
  }
  return url;
}

function readDmgFileName(url: URL): string {
  let fileName: string;
  try {
    fileName = posix.basename(decodeURIComponent(url.pathname));
  } catch {
    throw new Error("macOS update DMG filename is invalid");
  }
  if (!fileName.toLowerCase().endsWith(".dmg") || fileName === ".dmg") {
    throw new Error("macOS update manifest does not contain a DMG artifact");
  }
  return fileName;
}

export function selectVerifiedMacDmgArtifact(
  manifest: MacUpdateManifestLike,
): VerifiedMacDmgArtifact {
  const candidate = manifest.files?.find((file) => {
    if (typeof file?.url !== "string") return false;
    try {
      return resolveDmgUrl(file.url, manifest.lcodeManifestBaseUrl)
        .pathname.toLowerCase()
        .endsWith(".dmg");
    } catch {
      return false;
    }
  });
  if (!candidate?.url) {
    throw new Error("macOS update manifest does not contain a DMG artifact");
  }

  const url = resolveDmgUrl(candidate.url, manifest.lcodeManifestBaseUrl);
  const size = candidate.size;
  if (size != null && (!Number.isSafeInteger(size) || size <= 0)) {
    throw new Error("macOS update DMG size is invalid");
  }
  return {
    url: url.href,
    fileName: readDmgFileName(url),
    sha512: normalizeSha512(candidate.sha512),
    ...(size == null ? {} : { size }),
  };
}

async function calculateFileSha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("base64");
}

async function isVerifiedCachedFile(
  path: string,
  artifact: VerifiedMacDmgArtifact,
): Promise<boolean> {
  const file = await stat(path).catch(() => null);
  if (!file?.isFile()) return false;
  if (artifact.size != null && file.size !== artifact.size) return false;
  return (await calculateFileSha512(path)) === artifact.sha512;
}

function readContentLength(response: MacUpdateResponse): number | null {
  const value = Number(response.headers.get("content-length"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("cancelled");
}

export async function downloadVerifiedMacDmg(options: {
  artifact: VerifiedMacDmgArtifact;
  directory: string;
  fetcher: MacUpdateFetch;
  signal?: AbortSignal;
  onProgress?: (transferredBytes: number, totalBytes: number | null) => void;
}): Promise<string> {
  const { artifact, fetcher, signal, onProgress } = options;
  await mkdir(options.directory, { recursive: true });
  const destination = resolve(options.directory, artifact.fileName);
  if (await isVerifiedCachedFile(destination, artifact)) {
    const size = (await stat(destination)).size;
    onProgress?.(size, artifact.size ?? size);
    return destination;
  }
  await rm(destination, { force: true });

  throwIfCancelled(signal);
  const response = await fetcher(artifact.url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `macOS update DMG download failed: HTTP ${response.status} ${response.statusText}`.trim(),
    );
  }

  const temporary = `${destination}.partial-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  const hash = createHash("sha512");
  const totalBytes = artifact.size ?? readContentLength(response);
  let transferredBytes = 0;
  try {
    try {
      for await (const value of response.body) {
        throwIfCancelled(signal);
        const chunk = Buffer.from(value);
        if (artifact.size != null && transferredBytes + chunk.length > artifact.size) {
          // 功能原因：manifest 已给出最终字节数时立即限制写入，避免异常响应持续占满更新缓存。
          throw new Error(
            `macOS update DMG size mismatch: expected ${artifact.size}, received more bytes`,
          );
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (bytesWritten <= 0) throw new Error("macOS update DMG write made no progress");
          offset += bytesWritten;
        }
        transferredBytes += chunk.length;
        onProgress?.(transferredBytes, totalBytes);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    throwIfCancelled(signal);
    if (artifact.size != null && transferredBytes !== artifact.size) {
      throw new Error(
        `macOS update DMG size mismatch: expected ${artifact.size}, received ${transferredBytes}`,
      );
    }
    if (hash.digest("base64") !== artifact.sha512) {
      throw new Error("macOS update DMG SHA-512 checksum mismatch");
    }
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}
