import { join, relative, resolve, sep } from "node:path";
import {
  isFileSystemPortError,
  PROJECT_MEMORY_FILE_MAX_BYTES,
  type FileSystemListDirectoryEntry,
  type FileSystemPort,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { scanMemoryCandidatePaths } from "./recall/manifest.js";
import { MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT } from "./recall/constants.js";
import { tokenizeMemoryRecallText } from "./recall/tokenizer.js";
import { memoryReviewProfile } from "./review-profile.js";
import {
  assertSafeReviewFileName,
  createReviewSource,
  MemoryReviewError,
  reviewFileName,
  reviewIO,
  reviewTrace,
  REVIEW_CATALOG_CHARACTER_LIMIT,
  type FrozenReviewSource,
} from "./review-common.js";

const RAW_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROBE_FILE_NAME = "review-path-check.md";
const CONTROL_CHARACTER_LIMIT = 32;

export interface ReviewMemoryEvidence {
  materials: FrozenReviewSource[];
  fileNames: string[];
  otherMemoryFileNames: string[];
  partial: boolean;
}

export async function collectReviewMemoryEvidence(
  query: string,
  context: ToolExecutionContext,
): Promise<ReviewMemoryEvidence> {
  const profile = memoryReviewProfile(context);
  let partial = false;
  let scanFailure: unknown;
  const rootDir = resolve(context.memoryRoot!);
  // 复用同一个有界枚举器，但不借 manifest 预览偷偷读取全部候选正文。
  const scanPort = {
    listDirectory: async (request: Parameters<FileSystemPort["listDirectory"]>[0]) => {
      let result;
      try {
        result = await listReviewDirectory(context, request.path, request.limit!);
      } catch (error) {
        // recall 扫描器允许跳过失败目录；复盘必须保留并重新抛出安全边界失败。
        scanFailure = error;
        throw error;
      }
      partial ||= result.truncated;
      const entries = result.entries.map((entry): FileSystemListDirectoryEntry => {
        if (entry.kind !== "file" && entry.kind !== "directory") {
          partial = true;
          return entry;
        }
        try {
          const relativeName = relative(rootDir, entry.path).split(sep).join("/");
          assertSafeReviewFileName(
            entry.kind === "directory" ? `${relativeName}/${PROBE_FILE_NAME}` : relativeName,
            rootDir,
          );
          return entry;
        } catch {
          partial = true;
          // 拒绝项仍消耗扫描预算；若直接filter，很多无效文件会绕过枚举器的总entry上限。
          return { ...entry, kind: "other" };
        }
      });
      return { ...result, entries };
    },
  } as FileSystemPort;
  const { paths, scan } = await reviewIO(context, () =>
    scanMemoryCandidatePaths({
      fileSystem: scanPort,
      rootDir,
      signal: context.abortSignal,
      traceContext: reviewTrace(context),
    }),
  );
  if (scanFailure !== undefined) throw scanFailure;
  partial ||= !scan.complete;
  const tokens = [...new Set(tokenizeMemoryRecallText(query))];
  const fileNames = [...new Set(paths.map((path) => reviewFileName(rootDir, path)))];
  const relevance = (name: string) =>
    tokens.reduce(
      (score, token) => score + Number(name.normalize("NFKC").toLowerCase().includes(token)),
      0,
    );
  fileNames.sort(
    (left, right) =>
      relevance(right) - relevance(left) || (left < right ? -1 : left > right ? 1 : 0),
  );
  partial ||= fileNames.length > profile.memoryLimit;
  const materials: FrozenReviewSource[] = [];
  let characters = 0;
  for (const fileName of fileNames.slice(0, profile.memoryLimit)) {
    const material = await readReviewMemoryEvidence(fileName, context);
    if (!material || characters + material.content.length > profile.memoryCharacterLimit) {
      partial = true;
      continue;
    }
    materials.push(material);
    characters += material.content.length;
  }
  const readNames = new Set(materials.map((material) => material.source.reference));
  const otherMemoryFileNames: string[] = [];
  let catalogCharacters = 0;
  for (const fileName of fileNames.filter((name) => !readNames.has(name))) {
    const cost = JSON.stringify(fileName).length;
    if (catalogCharacters + cost > REVIEW_CATALOG_CHARACTER_LIMIT) {
      partial = true;
      break;
    }
    otherMemoryFileNames.push(fileName);
    catalogCharacters += cost;
  }
  return { materials, fileNames, otherMemoryFileNames, partial };
}

export async function readReviewMemoryEvidence(
  fileName: string,
  context: ToolExecutionContext,
): Promise<FrozenReviewSource | undefined> {
  const path = assertSafeReviewFileName(fileName, context.memoryRoot!);
  if (!(await verifyReviewPath(fileName, context))) return undefined;
  const read = await reviewIO(context, async () => {
    try {
      return await context.fileSystemPort!.readTextFile(
        {
          path,
          maxBytes: PROJECT_MEMORY_FILE_MAX_BYTES,
          trace: reviewTrace(context),
        },
        { signal: context.abortSignal },
      );
    } catch (error) {
      if (
        isFileSystemPortError(error) &&
        ["not_found", "too_large", "permission_denied"].includes(error.code)
      )
        return undefined;
      throw error;
    }
  });
  if (!read) return undefined;
  if (
    resolve(read.path) !== path ||
    read.bytesRead > PROJECT_MEMORY_FILE_MAX_BYTES ||
    read.sizeBytes > PROJECT_MEMORY_FILE_MAX_BYTES ||
    Buffer.byteLength(read.content) > PROJECT_MEMORY_FILE_MAX_BYTES
  ) {
    throw new MemoryReviewError("source_unavailable");
  }
  // 不能把 LF 归一化正文的 hash 冒充原始字节版本，也不能让部分读取变成可编辑目标。
  const expectedHash = read.revision?.hash;
  if (
    read.truncated ||
    !Number.isSafeInteger(read.bytesRead) ||
    read.bytesRead !== read.sizeBytes ||
    !expectedHash ||
    !RAW_HASH_PATTERN.test(expectedHash) ||
    !read.content.trim()
  )
    return undefined;
  return {
    source: createReviewSource({
      context,
      kind: "memory",
      reference: fileName,
      characterLimit: 0,
      material: { content: read.content, expectedHash },
    }),
    content: read.content,
    expectedHash,
    partial: false,
  };
}

export async function expectedReviewTargetHash(input: {
  fileName: string;
  memory: ReviewMemoryEvidence;
  context: ToolExecutionContext;
}): Promise<string | null> {
  const { fileName, memory, context } = input;
  const path = assertSafeReviewFileName(fileName, context.memoryRoot!);
  const frozen = memory.materials.find((material) => material.source.reference === fileName);
  if (frozen?.expectedHash) return frozen.expectedHash;
  if (memory.fileNames.some((name) => name.toLowerCase() === fileName.toLowerCase())) {
    throw new MemoryReviewError("invalid_target");
  }
  // 模型看不到的新目标只准确认“不存在”；存在但未冻结的文件不能在此扩大正文读取范围。
  if (await verifyReviewPath(fileName, context)) throw new MemoryReviewError("invalid_target");
  const missing = await reviewIO(
    context,
    async () => {
      try {
        const stat = await context.fileSystemPort!.stat(
          { path, trace: reviewTrace(context) },
          { signal: context.abortSignal },
        );
        return stat.kind === "missing";
      } catch (error) {
        if (isFileSystemPortError(error) && error.code === "not_found") return true;
        throw error;
      }
    },
    "invalid_target",
  );
  if (!missing) throw new MemoryReviewError("invalid_target");
  return null;
}

async function verifyReviewPath(fileName: string, context: ToolExecutionContext): Promise<boolean> {
  assertSafeReviewFileName(fileName, context.memoryRoot!);
  const segments = fileName.split("/");
  let directory = resolve(context.memoryRoot!);
  for (let index = 0; index < segments.length; index++) {
    const result = await listReviewDirectory(
      context,
      directory,
      MEMORY_RECALL_DIRECTORY_ENTRY_LIMIT,
    );
    const segment = segments[index]!;
    const entry = result.entries.find(
      (candidate) => candidate.name.toLowerCase() === segment.toLowerCase(),
    );
    if (!entry) {
      if (result.truncated) throw new MemoryReviewError("invalid_target");
      return false;
    }
    if (
      entry.name !== segment ||
      entry.kind !== (index === segments.length - 1 ? "file" : "directory")
    ) {
      throw new MemoryReviewError("invalid_target");
    }
    directory = entry.path;
  }
  return true;
}

async function listReviewDirectory(
  context: ToolExecutionContext,
  directory: string,
  limit: number,
) {
  const root = resolve(context.memoryRoot!);
  const dir = resolve(directory);
  if (dir !== root) {
    const name = relative(root, dir).split(sep).join("/");
    assertSafeReviewFileName(`${name}/${PROBE_FILE_NAME}`, root);
  }
  const result = await reviewIO(context, async () => {
    try {
      return await context.fileSystemPort!.listDirectory(
        {
          path: dir,
          limit,
          trace: reviewTrace(context),
        },
        { signal: context.abortSignal },
      );
    } catch (error) {
      if (isFileSystemPortError(error) && error.code === "not_found") {
        return { path: dir, entries: [], numEntries: 0, durationMs: 0, truncated: false };
      }
      throw error;
    }
  });
  if (resolve(result.path) !== dir || result.entries.length > limit)
    throw new MemoryReviewError("budget_exceeded");
  for (const entry of result.entries) assertDirectoryEntry(entry, dir);
  return result;
}

function assertDirectoryEntry(entry: FileSystemListDirectoryEntry, directory: string): void {
  const hasControl = [...entry.name].some(
    (character) => character.codePointAt(0)! < CONTROL_CHARACTER_LIMIT,
  );
  if (
    !entry.name ||
    entry.name === "." ||
    entry.name === ".." ||
    /[\\/:]/u.test(entry.name) ||
    hasControl ||
    resolve(entry.path) !== join(directory, entry.name)
  ) {
    throw new MemoryReviewError("source_unavailable");
  }
}
