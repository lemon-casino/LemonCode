import { open, readFile, stat } from "node:fs/promises";
import {
  createFileSystemError,
  type FileSystemReadBytesRequest,
  type FileSystemReadBytesResult,
  type FileSystemReadTextRequest,
  type FileSystemReadTextResult,
  type FileSystemReadTextRangeRequest,
  type FileSystemReadTextRangeResult,
} from "@lcode/contracts";
import {
  decodeTextBuffer,
  detectLineEndings,
  normalizeLineEndings,
  shouldNormalizeLineEndings,
} from "./text-metadata.js";
import { readTextFileRangeFromNode } from "./text-range-reader.js";
import {
  formatByteCount,
  hashBuffer,
  resolveAbsoluteRequestPath,
  revisionId,
  toFileSystemError,
} from "./file-system-common.js";

export async function readTextFile(
  request: FileSystemReadTextRequest,
): Promise<FileSystemReadTextResult> {
  const path = resolveAbsoluteRequestPath(request.path);

  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      throw createFileSystemError({
        code: "is_directory",
        path,
        message: `Cannot read directory as text file: ${path}`,
      });
    }
    if (!info.isFile()) {
      throw createFileSystemError({
        code: "not_file",
        path,
        message: `Cannot read non-file path as text: ${path}`,
      });
    }

    const maxBytes = request.maxBytes;
    const truncated = maxBytes !== undefined && info.size > maxBytes;
    const buffer = truncated ? await readFirstBytes(path, maxBytes) : await readFile(path);
    const decoded = decodeTextBuffer({ buffer, encoding: request.encoding, path });
    const rawContent = decoded.content;
    const encoding = decoded.encoding;
    const isText = shouldNormalizeLineEndings(encoding);
    const lineEndings = isText ? detectLineEndings(rawContent) : undefined;
    const content = isText ? normalizeLineEndings(rawContent) : rawContent;

    return {
      path,
      content,
      encoding,
      lineEndings,
      bytesRead: buffer.byteLength,
      sizeBytes: info.size,
      truncated,
      revision: {
        id: revisionId(info.mtimeMs, info.size),
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        hash: hashBuffer(buffer),
      },
    };
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

export async function readBinaryFile(
  request: FileSystemReadBytesRequest,
): Promise<FileSystemReadBytesResult> {
  const path = resolveAbsoluteRequestPath(request.path);

  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      throw createFileSystemError({
        code: "is_directory",
        path,
        message: `Cannot read directory as binary file: ${path}`,
      });
    }
    if (!info.isFile()) {
      throw createFileSystemError({
        code: "not_file",
        path,
        message: `Cannot read non-file path as binary: ${path}`,
      });
    }
    if (request.maxBytes !== undefined && info.size > request.maxBytes) {
      throw createFileSystemError({
        code: "too_large",
        path,
        message: `File content (${formatByteCount(info.size)}) exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
      });
    }

    const buffer =
      request.maxBytes === undefined
        ? await readFile(path)
        : await readAtMostBytes(path, request.maxBytes + 1, info.size);
    if (request.maxBytes !== undefined && buffer.byteLength > request.maxBytes) {
      // stat 与 readFile 之间文件可能增长；实际读取也必须保持有界，
      // 否则 maxBytes 既挡不住超限内容，也挡不住一次性大内存分配。
      throw createFileSystemError({
        code: "too_large",
        path,
        message: `File content exceeds maximum allowed size (${formatByteCount(request.maxBytes)}). Use a smaller file.`,
      });
    }
    return {
      path,
      content: buffer,
      bytesRead: buffer.byteLength,
      sizeBytes: info.size,
      revision: {
        id: revisionId(info.mtimeMs, info.size),
        mtimeMs: info.mtimeMs,
        sizeBytes: info.size,
        hash: hashBuffer(buffer),
      },
    };
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

export async function readTextFileRange(
  request: FileSystemReadTextRangeRequest,
  options?: { signal?: AbortSignal },
): Promise<FileSystemReadTextRangeResult> {
  const path = resolveAbsoluteRequestPath(request.path);

  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      throw createFileSystemError({
        code: "is_directory",
        path,
        message: `Cannot read directory as text file: ${path}`,
      });
    }
    if (!info.isFile()) {
      throw createFileSystemError({
        code: "not_file",
        path,
        message: `Cannot read non-file path as text: ${path}`,
      });
    }

    return await readTextFileRangeFromNode({ ...request, path }, info, options?.signal);
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readAtMostBytes(
  path: string,
  maxBytes: number,
  initialSizeBytes: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    // 稳定文件按 stat 大小一次读取；只有文件在 stat 后增长时才继续分块追到硬上限。
    const firstBuffer = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(1, initialSizeBytes + 1)));
    const chunks: Buffer[] = [];
    let bytesReadTotal = 0;
    while (bytesReadTotal < maxBytes) {
      const chunk =
        bytesReadTotal === 0
          ? firstBuffer
          : Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytesReadTotal));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytesReadTotal);
      // FileHandle.read 的短读不等于 EOF；只有明确返回 0 字节才能停止。
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytesReadTotal += bytesRead;
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bytesReadTotal);
  } finally {
    await handle.close();
  }
}
