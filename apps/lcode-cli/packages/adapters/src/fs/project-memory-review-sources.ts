import { resolve } from "node:path";
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_REVIEW_ITEM_LIMIT,
  ProjectMemoryChangeSchema,
  type ProjectMemoryPort,
  type ProjectMemoryReview,
  type ProjectMemoryReviewItem,
} from "@lcode/contracts";
import { getNodeErrorCode, hashBuffer, throwIfAborted } from "./file-system-common.js";
import { memoryError, readMemoryBytes } from "./project-memory-io.js";
import { checkMemoryTarget, memoryRelativePath, type MemoryRoot } from "./project-memory-paths.js";

type ExpectedSources = Parameters<ProjectMemoryPort["applyReview"]>[0]["expectedSourceHashes"];
const FULL_HASH = /^sha256:[a-f0-9]{64}$/u;
const sourceKey = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path;

function validateSourcePath(root: MemoryRoot, fileName: string): void {
  if (!ProjectMemoryChangeSchema.shape.fileName.safeParse(fileName).success) {
    throw memoryError(
      "invalid_path",
      fileName,
      "Project Memory source must be a contained relative Markdown path",
    );
  }
  memoryRelativePath(root, resolve(root.rootDir, fileName));
}

export function validateReviewSourceHashes(
  root: MemoryRoot,
  review: ProjectMemoryReview,
  item: ProjectMemoryReviewItem,
  expected: ExpectedSources,
): void {
  if (!Array.isArray(expected))
    throw memoryError("stale_write", review.id, "Project Memory source hashes are required");
  if (expected.length > PROJECT_MEMORY_REVIEW_ITEM_LIMIT) {
    throw memoryError(
      "too_large",
      review.id,
      "Project Memory source hash set exceeds its bounded read budget",
    );
  }
  const supplied = new Map<string, string>();
  for (const source of expected) {
    if (
      !source ||
      typeof source.fileName !== "string" ||
      typeof source.hash !== "string" ||
      !FULL_HASH.test(source.hash)
    ) {
      throw memoryError(
        "stale_write",
        review.id,
        "Project Memory source requires a complete raw-byte SHA256 hash",
      );
    }
    validateSourcePath(root, source.fileName);
    const key = sourceKey(source.fileName);
    if (supplied.has(key))
      throw memoryError("stale_write", source.fileName, "Duplicate Project Memory source hash");
    supplied.set(key, source.fileName);
  }
  const references = new Set<string>();
  const resolvedIds = new Set<string>();
  const itemIds = new Set(item.sourceIds);
  if (itemIds.size !== item.sourceIds.length)
    throw memoryError("stale_write", review.id, "Duplicate Project Memory source ID");
  for (const source of review.draft.sources) {
    if (!itemIds.has(source.id)) continue;
    if (resolvedIds.has(source.id))
      throw memoryError("stale_write", review.id, "Ambiguous Project Memory source ID");
    resolvedIds.add(source.id);
    if (source.kind !== "memory") continue;
    validateSourcePath(root, source.reference);
    const key = sourceKey(source.reference);
    if (references.has(key) || supplied.get(key) !== source.reference) {
      throw memoryError(
        "stale_write",
        source.reference,
        "Project Memory source hash set does not match the item's evidence",
      );
    }
    references.add(key);
  }
  if (resolvedIds.size !== itemIds.size || references.size !== supplied.size) {
    throw memoryError(
      "stale_write",
      review.id,
      "Project Memory source hash set must exactly cover the item's memory evidence",
    );
  }
}

export async function assertCurrentReviewSources(
  root: MemoryRoot,
  expected: ExpectedSources,
  signal?: AbortSignal,
): Promise<void> {
  // core 锁外复核后，协作 writer 仍可修正来源；来源与目标必须在同一 root 锁内检查再提交。
  for (const source of expected) {
    throwIfAborted(signal);
    let current: Buffer | null;
    try {
      const path = await checkMemoryTarget(root, source.fileName);
      current = await readMemoryBytes(path, PROJECT_MEMORY_FILE_MAX_BYTES, true);
    } catch (error) {
      if (getNodeErrorCode(error) !== "ENOENT") throw error;
      current = null;
    }
    if (current === null || hashBuffer(current) !== source.hash) {
      throw memoryError(
        "stale_write",
        source.fileName,
        "Project Memory source changed before the coordinated commit",
      );
    }
  }
  throwIfAborted(signal);
}
