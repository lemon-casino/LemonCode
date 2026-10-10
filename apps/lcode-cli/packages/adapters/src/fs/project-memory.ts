import { randomUUID } from "node:crypto";
import { withFileLock } from "@lcode/shared/node";
import {
  ProjectMemoryReviewDraftSchema,
  ProjectMemoryReviewItemSchema,
  ProjectMemoryVerificationSchema,
  type FileSystemOperationOptions,
  type FileSystemWriteTextRequest,
  type FileSystemWriteTextResult,
  type ProjectMemoryChange,
  type ProjectMemoryOperationOptions,
  type ProjectMemoryPort,
  type ProjectMemoryReview,
} from "@lcode/contracts";
import { hashBuffer, revisionId, throwIfAborted, toFileSystemError } from "./file-system-common.js";
import { memoryError } from "./project-memory-io.js";
import { MemoryJournal } from "./project-memory-journal.js";
import {
  assertMemoryRoot,
  checkLockPath,
  checkMemoryTarget,
  contained,
  memoryRelativePath,
  MemoryRootRegistry,
  prepareMemoryRoot,
  samePath,
  type MemoryRoot,
} from "./project-memory-paths.js";
import { MemoryStore } from "./project-memory-store.js";
import { MemoryEffects } from "./project-memory-effects.js";
import {
  assertCurrentReviewSources,
  validateReviewSourceHashes,
} from "./project-memory-review-sources.js";
import { applyRequestedLineEndings, decodeTextBuffer, encodeTextContent } from "./text-metadata.js";

const FULL_HASH = /^sha256:[a-f0-9]{64}$/u;
interface LockedMemory {
  store: MemoryStore;
  journal: MemoryJournal;
  changes: ProjectMemoryChange[];
}

function projectReview(
  review: ProjectMemoryReview,
  changes: readonly ProjectMemoryChange[],
): ProjectMemoryReview {
  const appliedItems = new Map<string, string>();
  for (const change of changes) {
    if (change.proposalId !== review.id || change.status !== "committed" || !change.proposalItemId)
      continue;
    if (appliedItems.has(change.proposalItemId))
      throw memoryError(
        "io_error",
        review.id,
        "Duplicate committed Project Memory proposal application",
      );
    appliedItems.set(change.proposalItemId, change.id);
  }
  return { ...review, appliedItems: Object.fromEntries(appliedItems) };
}

export class NodeProjectMemory implements ProjectMemoryPort {
  private readonly registry = new MemoryRootRegistry();
  readonly effects = new MemoryEffects(async (rootDir, operation, options) =>
    this.locked(this.registry.get(rootDir), operation, options),
  );

  async registerRoot(rootDir: string): Promise<void> {
    try {
      let existing: MemoryRoot | undefined;
      try {
        existing = this.registry.get(rootDir);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "unsupported"))
          throw error;
      }
      if (existing) {
        await this.locked(existing, async () => {});
        return;
      }
      const root = await prepareMemoryRoot(rootDir);
      for (const other of this.registry.roots.values()) {
        if (
          contained(other.rootDir, root.rootDir) ||
          contained(root.rootDir, other.rootDir) ||
          samePath(root.stateDir, other.stateDir) ||
          contained(other.stateDir, root.rootDir) ||
          contained(root.stateDir, other.rootDir)
        ) {
          throw memoryError(
            "invalid_path",
            rootDir,
            "Project Memory roots and control directories must not overlap",
          );
        }
      }
      await this.locked(root, async () => {});
      this.registry.roots.set(root.rootDir, root);
    } catch (error) {
      throw toFileSystemError(error, rootDir);
    }
  }

  private async locked<T>(
    root: MemoryRoot,
    operation: (state: LockedMemory) => Promise<T>,
    options?: ProjectMemoryOperationOptions,
  ): Promise<T> {
    try {
      throwIfAborted(options?.signal);
      await checkLockPath(root);
      return await withFileLock(root.lockPath, async () => {
        // FIFO 等待期间允许取消；获得锁后必须先检查，不能补写一次“已取消”的请求。
        throwIfAborted(options?.signal);
        await assertMemoryRoot(root);
        const store = new MemoryStore(root);
        await store.initialize();
        const journal = new MemoryJournal(store);
        const changes = await journal.recover(options);
        throwIfAborted(options?.signal);
        return operation({ store, journal, changes });
      });
    } catch (error) {
      throw toFileSystemError(error, root.rootDir);
    }
  }

  async guardOrdinaryMutation(path: string, action: "remove" | "mkdir"): Promise<void> {
    try {
      const root = await this.registry.route(path);
      if (root) {
        await assertMemoryRoot(root);
        if (action === "remove" && /\.md$/iu.test(path)) {
          throw memoryError(
            "unsupported",
            path,
            "Project Memory deletion is not supported by the managed writer",
          );
        }
      }
    } catch (error) {
      throw toFileSystemError(error, path);
    }
  }

  async write(
    request: FileSystemWriteTextRequest,
    options?: FileSystemOperationOptions,
  ): Promise<FileSystemWriteTextResult | undefined> {
    try {
      const root = await this.registry.route(request.path);
      if (!root || !/\.md$/iu.test(request.path)) return undefined;
      const fileName = memoryRelativePath(root, request.path);
      if (
        (request.expectedMissing && request.expectedRevision) ||
        (!request.expectedMissing && !FULL_HASH.test(request.expectedRevision?.hash ?? ""))
      ) {
        throw memoryError(
          "stale_write",
          request.path,
          "Managed Markdown requires expectedMissing or a full raw-byte SHA256 revision",
        );
      }
      const content = encodeTextContent({
        content: applyRequestedLineEndings(request.content, request.lineEndings),
        encoding: request.encoding,
        path: request.path,
      });
      return await this.locked(
        root,
        async ({ journal, changes }) => {
          let mtimeMs: number | undefined;
          const change = await journal.commit(
            {
              fileName,
              content,
              expectedHash: request.expectedMissing ? null : request.expectedRevision!.hash!,
              createParents: request.createParents,
              onStaged: (mtime) => {
                mtimeMs = mtime;
              },
            },
            changes,
            {
              signal: options?.signal ?? options?.context?.abortSignal,
              trace: request.trace ?? options?.context?.trace,
            },
          );
          // 临时 inode 的 mtime 随原子发布保留；不在提交后追加易失败的 stat 来决定返回成功。
          return {
            path: request.path,
            bytesWritten: content.length,
            revision: {
              id: mtimeMs === undefined ? change.afterHash : revisionId(mtimeMs, content.length),
              mtimeMs,
              hash: change.afterHash,
              sizeBytes: content.length,
            },
          };
        },
        {
          signal: options?.signal ?? options?.context?.abortSignal,
          trace: request.trace ?? options?.context?.trace,
        },
      );
    } catch (error) {
      throw toFileSystemError(error, request.path);
    }
  }

  async inspectCapacity(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryPort["inspectCapacity"]> {
    return this.locked(
      this.registry.get(rootDir),
      async ({ store, changes }) => store.inspectCapacity(changes),
      options,
    );
  }

  async listChanges(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange[]> {
    return this.locked(this.registry.get(rootDir), async ({ changes }) => changes, options);
  }

  async previewUndo(
    input: Parameters<ProjectMemoryPort["previewUndo"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<{ change: ProjectMemoryChange; content: string }> {
    return this.locked(
      this.registry.get(input.rootDir),
      async ({ journal, changes }) => {
        const { change, before } = await journal.replaceForUndo(input.changeId, changes);
        return { change, content: decodeTextBuffer({ buffer: before }).content };
      },
      options,
    );
  }

  async undoChange(
    input: Parameters<ProjectMemoryPort["undoChange"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange> {
    return this.locked(
      this.registry.get(input.rootDir),
      async ({ journal, changes }) => {
        const { change, before } = await journal.replaceForUndo(input.changeId, changes);
        if (
          input.expectedHash !== change.afterHash ||
          input.expectedBeforeHash !== change.beforeHash
        ) {
          throw memoryError(
            "stale_write",
            input.changeId,
            "Project Memory undo no longer matches the approved hashes",
          );
        }
        return journal.commit(
          {
            fileName: change.fileName,
            content: before,
            expectedHash: input.expectedHash,
            undoOf: change.id,
          },
          changes,
          options,
        );
      },
      options,
    );
  }

  async saveReview(
    input: Parameters<ProjectMemoryPort["saveReview"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview> {
    return this.locked(
      this.registry.get(input.rootDir),
      async ({ store }) => {
        const parsed = ProjectMemoryReviewDraftSchema.safeParse(input.draft);
        if (!parsed.success)
          throw memoryError("invalid_path", input.rootDir, "Invalid Project Memory review draft");
        for (const item of parsed.data.items) {
          // 只验证，不创建提案里的目录或正文；未批准提案永远不进入 recall 根。
          memoryRelativePath(store.root, `${store.root.rootDir}/${item.fileName}`);
        }
        const review: ProjectMemoryReview = {
          schemaVersion: 1,
          id: randomUUID(),
          createdAt: Date.now(),
          revision: 1,
          draft: parsed.data,
          ...(input.verification
            ? { verification: ProjectMemoryVerificationSchema.parse(input.verification) }
            : {}),
          appliedItems: {},
        };
        throwIfAborted(options?.signal);
        await store.saveReview(review);
        return review;
      },
      options,
    );
  }

  async readReview(
    input: Parameters<ProjectMemoryPort["readReview"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview> {
    return this.locked(
      this.registry.get(input.rootDir),
      async ({ store, changes }) =>
        projectReview(await store.readReview(input.proposalId), changes),
      options,
    );
  }

  async listReviews(
    rootDir: string,
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryReview[]> {
    return this.locked(
      this.registry.get(rootDir),
      async ({ store, changes }) =>
        (await store.listReviews()).map((review) => projectReview(review, changes)),
      options,
    );
  }

  async applyReview(
    input: Parameters<ProjectMemoryPort["applyReview"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): Promise<ProjectMemoryChange> {
    return this.locked(
      this.registry.get(input.rootDir),
      async ({ store, journal, changes }) => {
        const review = await store.readReview(input.proposalId);
        const item = review.draft.items.find((entry) => entry.id === input.itemId);
        if (!item)
          throw memoryError(
            "not_found",
            input.itemId,
            "Project Memory proposal item does not exist",
          );
        const itemHash = hashBuffer(
          Buffer.from(JSON.stringify(ProjectMemoryReviewItemSchema.parse(item))),
        );
        if (review.revision !== input.revision || itemHash !== input.expectedItemHash) {
          throw memoryError(
            "stale_write",
            input.proposalId,
            "Project Memory proposal differs from the approved item or revision",
          );
        }
        validateReviewSourceHashes(store.root, review, item, input.expectedSourceHashes);
        const prior = changes.filter(
          (change) =>
            change.proposalId === review.id &&
            change.proposalItemId === item.id &&
            change.status !== "not-committed",
        );
        if (prior.length > 1)
          throw memoryError("io_error", review.id, "Duplicate Project Memory application records");
        if (prior[0]) {
          const applied = prior[0];
          if (
            applied.status !== "committed" ||
            applied.fileName !== item.fileName ||
            applied.beforeHash !== item.expectedHash ||
            applied.afterHash !== hashBuffer(Buffer.from(item.content))
          ) {
            throw memoryError(
              "stale_write",
              input.proposalId,
              "Project Memory proposal needs recovery or differs from its committed journal",
            );
          }
          return applied;
        }
        await assertCurrentReviewSources(store.root, input.expectedSourceHashes, options?.signal);
        await checkMemoryTarget(store.root, item.fileName, true);
        // proposal 不在提交后重写；跨崩溃幂等键和 appliedItems 都来自同一份 journal。
        return journal.commit(
          {
            fileName: item.fileName,
            content: Buffer.from(item.content),
            expectedHash: item.expectedHash,
            createParents: true,
            proposalId: review.id,
            proposalItemId: item.id,
          },
          changes,
          options,
        );
      },
      options,
    );
  }
}
