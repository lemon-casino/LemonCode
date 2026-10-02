import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as yauzl from "yauzl";
import { normalizeZipRelativePath, resolveZipPathWithin, throwIfAborted } from "./zip-paths.js";

export const ZIP_EXTRACT_MAX_BYTES = 500 * 1024 * 1024;

export const ZIP_MAX_ENTRIES = 20_000;

export const ZIP_MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;

export interface ZipExtractResult {
  topLevelSegments: Set<string>;
}

export type ZipEntryKind = "directory" | "file";

export async function extractZipArchive(input: {
  archivePath: string;
  signal?: AbortSignal;
  targetRoot: string;
}): Promise<ZipExtractResult> {
  const targetRoot = resolve(input.targetRoot);
  await mkdir(targetRoot, { recursive: true });
  const zipFile = await openZipFile(input.archivePath);
  const topLevelSegments = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const rejectOnce = (error: unknown): void => {
        zipFile.close();
        rejectPromise(error);
      };
      zipFile.once("error", rejectOnce);
      zipFile.once("end", () => {
        zipFile.removeListener("error", rejectOnce);
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            throwIfAborted(input.signal);
            entryCount += 1;
            if (entryCount > ZIP_MAX_ENTRIES) {
              throw new Error(`Plugin zip has too many entries: ${entryCount}/${ZIP_MAX_ENTRIES}`);
            }

            const normalizedPath = normalizeZipRelativePath(entry.fileName);
            topLevelSegments.add(normalizedPath.split("/")[0] ?? normalizedPath);
            const targetPath = resolveZipPathWithin(targetRoot, normalizedPath);
            const kind = classifyZipEntry(entry);
            if (kind === "directory") {
              await mkdir(targetPath, { recursive: true });
              zipFile.readEntry();
              return;
            }

            if (entry.uncompressedSize > ZIP_MAX_SINGLE_FILE_BYTES) {
              throw new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`);
            }
            const bytes = await readZipEntryBuffer(zipFile, entry, input.signal);
            extractedBytes += bytes.byteLength;
            if (extractedBytes > ZIP_EXTRACT_MAX_BYTES) {
              throw new Error(
                `Plugin zip extracted content exceeds limit: ${extractedBytes}/${ZIP_EXTRACT_MAX_BYTES}`,
              );
            }
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, bytes);
            zipFile.readEntry();
          } catch (error) {
            rejectOnce(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  return { topLevelSegments };
}

export function openZipFile(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!zipFile) {
        rejectPromise(new Error("Failed to open plugin zip archive"));
        return;
      }
      resolvePromise(zipFile);
    });
  });
}

export function readZipEntryBuffer(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!stream) {
        rejectPromise(new Error(`Failed to read plugin zip entry: ${entry.fileName}`));
        return;
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        stream.destroy(new Error("Plugin operation cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.byteLength;
        if (bytesRead > ZIP_MAX_SINGLE_FILE_BYTES) {
          stream.destroy(
            new Error(`Plugin zip entry exceeds single file limit: ${entry.fileName}`),
          );
          return;
        }
        chunks.push(buffer);
      });
      stream.once("error", (streamError) => {
        cleanup();
        rejectPromise(streamError);
      });
      stream.once("end", () => {
        cleanup();
        resolvePromise(Buffer.concat(chunks));
      });
    });
  });
}

export function classifyZipEntry(entry: yauzl.Entry): ZipEntryKind {
  const isDirectoryByName = entry.fileName.endsWith("/");
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted plugin zip entries are not supported: ${entry.fileName}`);
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) {
    throw new Error(`Plugin zip entry symlinks are not supported: ${entry.fileName}`);
  }
  if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
    throw new Error(`Unsupported plugin zip entry type: ${entry.fileName}`);
  }
  if (fileType === 0o040000 || isDirectoryByName) return "directory";
  return "file";
}
