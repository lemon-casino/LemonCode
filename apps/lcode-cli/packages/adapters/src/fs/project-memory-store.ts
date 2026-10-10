import { join } from "node:path";
import { opendir } from "node:fs/promises";
import { z } from "zod";
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_PREIMAGES_MAX_BYTES,
  PROJECT_MEMORY_RECORD_LIMIT,
  PROJECT_MEMORY_RECORD_MAX_BYTES,
  ProjectMemoryChangeSchema,
  ProjectMemoryReviewSchema,
  type ProjectMemoryChange,
  type ProjectMemoryPort,
  type ProjectMemoryReview,
} from "@lcode/contracts";
import { hashBuffer } from "./file-system-common.js";
import {
  listMemoryFiles,
  MEMORY_TEMP_PREFIX,
  memoryError,
  readMemoryBytes,
  strictAtomicWrite,
} from "./project-memory-io.js";
import {
  assertMemoryRoot,
  initializeMemoryDirectories,
  type MemoryRoot,
  localAbsolutePath,
  samePath,
} from "./project-memory-paths.js";

const OwnerSchema = z.object({ schemaVersion: z.literal(1), rootDir: z.string() }).strict();
// contracts 仍使用 Zod 3；adapter 的 Zod 4 不得把其 schema 嵌入本地 object。
const ChangeRecordSchema = OwnerSchema.extend({ change: z.unknown() }).strict();
const ReviewRecordSchema = OwnerSchema.extend({ review: z.unknown() }).strict();
const RECORD_EXTENSION = ".json";
const PREIMAGE_EXTENSION = ".bin";
const RECORD_NAME = /^[a-zA-Z0-9_-]{8,96}$/u;

export class MemoryStore {
  constructor(readonly root: MemoryRoot) {}

  private async readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    await assertMemoryRoot(this.root);
    const bytes = await readMemoryBytes(path, PROJECT_MEMORY_RECORD_MAX_BYTES);
    try {
      return schema.parse(JSON.parse(bytes!.toString("utf8")));
    } catch (cause) {
      throw memoryError(
        "io_error",
        path,
        `Invalid Project Memory record: ${cause instanceof SyntaxError ? "JSON" : "schema"}`,
      );
    }
  }

  private assertOwner(rootDir: string): void {
    if (!samePath(localAbsolutePath(rootDir), this.root.rootDir)) {
      throw memoryError(
        "invalid_path",
        rootDir,
        "Project Memory sidecar belongs to a different registered root",
      );
    }
  }

  private path(directory: string, id: string, extension = RECORD_EXTENSION): string {
    if (!RECORD_NAME.test(id))
      throw memoryError("invalid_path", id, "Invalid Project Memory record ID");
    return join(this.root.stateDir, directory, `${id}${extension}`);
  }

  private async writeRecord(
    path: string,
    record: unknown,
    expectedMissing: boolean,
  ): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > PROJECT_MEMORY_RECORD_MAX_BYTES)
      throw memoryError("too_large", path, "Project Memory record exceeds its byte budget");
    await strictAtomicWrite(path, bytes, {
      expectedMissing,
      mode: 0o600,
      validate: () => assertMemoryRoot(this.root),
    });
  }

  async initialize(): Promise<void> {
    await initializeMemoryDirectories(this.root);
    const ownerPath = join(this.root.stateDir, "owner.json");
    const directory = await opendir(this.root.stateDir);
    let entryCount = 0;
    let temporaryCount = 0;
    const controlEntries = new Set([
      "owner.json",
      "writer.lock",
      "journal",
      "preimages",
      "reviews",
      "staging",
      "effects.json",
    ]);
    for await (const entry of directory) {
      if (++entryCount > PROJECT_MEMORY_RECORD_LIMIT + controlEntries.size)
        throw memoryError(
          "too_large",
          this.root.stateDir,
          "Project Memory root sidecar staging is full; no files were deleted",
        );
      if (controlEntries.has(entry.name)) continue;
      if (!entry.name.startsWith(MEMORY_TEMP_PREFIX) || !entry.name.endsWith(".tmp"))
        throw memoryError(
          "io_error",
          this.root.stateDir,
          "Unexpected Project Memory root sidecar entry",
        );
      if (++temporaryCount >= PROJECT_MEMORY_RECORD_LIMIT)
        throw memoryError(
          "too_large",
          this.root.stateDir,
          "Project Memory root sidecar staging is full; no files were deleted",
        );
      await readMemoryBytes(join(this.root.stateDir, entry.name), PROJECT_MEMORY_RECORD_MAX_BYTES);
    }
    const bytes = await readMemoryBytes(ownerPath, PROJECT_MEMORY_RECORD_MAX_BYTES, true);
    if (bytes === null) {
      await this.writeRecord(ownerPath, { schemaVersion: 1, rootDir: this.root.rootDir }, true);
    } else {
      const owner = await this.readRecord(ownerPath, OwnerSchema);
      this.assertOwner(owner.rootDir);
    }
  }

  async inventory(
    directory: "journal" | "reviews" | "preimages" | "staging",
  ): Promise<Map<string, number>> {
    await assertMemoryRoot(this.root);
    const files = await listMemoryFiles(
      join(this.root.stateDir, directory),
      directory === "preimages" || directory === "staging"
        ? PROJECT_MEMORY_FILE_MAX_BYTES
        : PROJECT_MEMORY_RECORD_MAX_BYTES,
    );
    if (
      directory === "preimages" &&
      [...files.values()].reduce((total, size) => total + size, 0) >
        PROJECT_MEMORY_PREIMAGES_MAX_BYTES
    ) {
      throw memoryError(
        "too_large",
        this.root.stateDir,
        "Project Memory preimages exceed their total byte budget; no files were deleted",
      );
    }
    return files;
  }

  private names(files: Map<string, number>, extension: string): string[] {
    const ids: string[] = [];
    for (const name of files.keys()) {
      // 崩溃残留占预算但不冒充记录；不静默删除任何已有文件。
      if (name.startsWith(MEMORY_TEMP_PREFIX) && name.endsWith(".tmp")) continue;
      const id = name.slice(0, -extension.length);
      if (!name.endsWith(extension) || !RECORD_NAME.test(id)) {
        throw memoryError("io_error", this.root.stateDir, "Unexpected Project Memory control file");
      }
      ids.push(id);
    }
    return ids;
  }

  async readChanges(): Promise<ProjectMemoryChange[]> {
    const journal = await this.inventory("journal");
    const preimages = await this.inventory("preimages");
    this.names(preimages, PREIMAGE_EXTENSION);
    const changes: ProjectMemoryChange[] = [];
    for (const id of this.names(journal, RECORD_EXTENSION)) {
      const record = await this.readRecord(this.path("journal", id), ChangeRecordSchema);
      this.assertOwner(record.rootDir);
      const parsed = ProjectMemoryChangeSchema.safeParse(record.change);
      if (!parsed.success)
        throw memoryError("io_error", id, "Invalid Project Memory change schema");
      const change = parsed.data;
      if (change.id !== id || Boolean(change.proposalId) !== Boolean(change.proposalItemId)) {
        throw memoryError("io_error", id, "Project Memory journal identity is inconsistent");
      }
      const recordBytes =
        journal.get(`${id}${RECORD_EXTENSION}`)! +
        (preimages.get(`${id}${PREIMAGE_EXTENSION}`) ?? 0);
      if (recordBytes > PROJECT_MEMORY_RECORD_MAX_BYTES)
        throw memoryError(
          "too_large",
          id,
          "Project Memory journal and preimage exceed their combined byte budget",
        );
      changes.push(change);
    }
    return changes.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async inspectCapacity(
    changes: readonly ProjectMemoryChange[],
  ): ReturnType<ProjectMemoryPort["inspectCapacity"]> {
    const journal = await this.inventory("journal");
    const reviews = await this.inventory("reviews");
    const preimages = await this.inventory("preimages");
    const staging = await this.inventory("staging");
    // 满额是正常不可用状态，损坏/跨根提案却不能被“空间满”掩盖。
    for (const id of this.names(reviews, RECORD_EXTENSION)) await this.readReview(id);
    if (
      changes.some(
        (change) => change.status === "prepared" || change.status === "recovery-required",
      )
    )
      return { available: false, reason: "recovery-required" };
    if (journal.size >= PROJECT_MEMORY_RECORD_LIMIT || staging.size >= PROJECT_MEMORY_RECORD_LIMIT)
      return { available: false, reason: "history-full" };
    if (reviews.size >= PROJECT_MEMORY_RECORD_LIMIT)
      return { available: false, reason: "reviews-full" };
    const beforeBytes = [...preimages.values()].reduce((total, size) => total + size, 0);
    // 在首个模型请求前保守预留单次最大前像；真正提交仍按实际字节再检查防竞争。
    if (
      preimages.size >= PROJECT_MEMORY_RECORD_LIMIT ||
      beforeBytes + PROJECT_MEMORY_FILE_MAX_BYTES > PROJECT_MEMORY_PREIMAGES_MAX_BYTES
    )
      return { available: false, reason: "preimages-full" };
    return { available: true };
  }

  async reserveChange(record: ProjectMemoryChange, before: Buffer | null): Promise<void> {
    const journal = await this.inventory("journal");
    const preimages = await this.inventory("preimages");
    const staging = await this.inventory("staging");
    if (
      journal.size >= PROJECT_MEMORY_RECORD_LIMIT ||
      staging.size >= PROJECT_MEMORY_RECORD_LIMIT ||
      (before !== null && preimages.size >= PROJECT_MEMORY_RECORD_LIMIT)
    ) {
      throw memoryError(
        "too_large",
        this.root.stateDir,
        "Project Memory history is full; no records were deleted",
      );
    }
    if (
      [...preimages.values()].reduce((total, size) => total + size, 0) + (before?.length ?? 0) >
      PROJECT_MEMORY_PREIMAGES_MAX_BYTES
    ) {
      throw memoryError(
        "too_large",
        this.root.stateDir,
        "Project Memory preimage storage is full; no files were deleted",
      );
    }
    const encoded = Buffer.byteLength(
      JSON.stringify({ schemaVersion: 1, rootDir: this.root.rootDir, change: record }),
    );
    if (encoded + (before?.length ?? 0) > PROJECT_MEMORY_RECORD_MAX_BYTES)
      throw memoryError("too_large", record.id, "Project Memory change exceeds its record budget");
    if (before !== null) {
      await strictAtomicWrite(this.path("preimages", record.id, PREIMAGE_EXTENSION), before, {
        expectedMissing: true,
        mode: 0o600,
        validate: () => assertMemoryRoot(this.root),
      });
    }
    await this.writeChange(record, true);
  }

  async writeChange(change: ProjectMemoryChange, expectedMissing = false): Promise<void> {
    await this.writeRecord(
      this.path("journal", change.id),
      {
        schemaVersion: 1,
        rootDir: this.root.rootDir,
        change: ProjectMemoryChangeSchema.parse(change),
      },
      expectedMissing,
    );
  }

  async readPreimage(change: ProjectMemoryChange): Promise<Buffer> {
    const path = this.path("preimages", change.id, PREIMAGE_EXTENSION);
    await assertMemoryRoot(this.root);
    const bytes = await readMemoryBytes(path, PROJECT_MEMORY_FILE_MAX_BYTES);
    if (change.beforeHash === null || hashBuffer(bytes!) !== change.beforeHash) {
      throw memoryError(
        "stale_write",
        path,
        "Project Memory preimage does not match the committed hash",
      );
    }
    return bytes!;
  }

  async readReview(id: string): Promise<ProjectMemoryReview> {
    const record = await this.readRecord(this.path("reviews", id), ReviewRecordSchema);
    this.assertOwner(record.rootDir);
    const parsed = ProjectMemoryReviewSchema.safeParse(record.review);
    if (!parsed.success) throw memoryError("io_error", id, "Invalid Project Memory review schema");
    const review = parsed.data;
    if (review.id !== id || Object.keys(review.appliedItems).length !== 0) {
      throw memoryError(
        "io_error",
        id,
        "Project Memory proposal must remain immutable; application truth belongs to the journal",
      );
    }
    return review;
  }

  async listReviews(): Promise<ProjectMemoryReview[]> {
    const reviews: ProjectMemoryReview[] = [];
    for (const id of this.names(await this.inventory("reviews"), RECORD_EXTENSION))
      reviews.push(await this.readReview(id));
    return reviews.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  async saveReview(review: ProjectMemoryReview): Promise<void> {
    if ((await this.inventory("reviews")).size >= PROJECT_MEMORY_RECORD_LIMIT) {
      throw memoryError(
        "too_large",
        this.root.stateDir,
        "Project Memory review storage is full; no records were deleted",
      );
    }
    await this.writeRecord(
      this.path("reviews", review.id),
      {
        schemaVersion: 1,
        rootDir: this.root.rootDir,
        review: ProjectMemoryReviewSchema.parse(review),
      },
      true,
    );
  }
}
