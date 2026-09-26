import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "./provider-config-file-codec.js";

export interface NodePersonalProviderConfigRepositoryOptions {
  readonly filePath: string;
  readonly importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPollingError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number | false;
}

export interface PersonalProviderConfigRecoveryEvent {
  readonly error: unknown;
}

export class NodePersonalProviderConfigRepository implements PersonalProviderConfigRepository {
  readonly #filePath: string;
  readonly #stateFilePath: string;
  readonly #importLegacy?: () => Promise<ProviderConfigLayerUpdate | null>;
  readonly #onRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly #onPollingError?: (error: unknown) => void;
  readonly #pollingIntervalMs: number | false;
  readonly #listeners = new Set<(reason: string) => void>();
  #pollingTimer: ReturnType<typeof setTimeout> | null = null;
  #pollingInFlight = false;
  #writeGeneration = 0;
  #observedSaveGenerationsRevision: string | null = null;
  #pollingErrorActive = false;
  #observedRevision: string | null = null;
  #disposed = false;

  constructor(options: NodePersonalProviderConfigRepositoryOptions) {
    if (!options.filePath.trim()) throw new Error("Personal Provider Config filePath 不能为空");
    this.#filePath = options.filePath;
    this.#stateFilePath = `${options.filePath}.runtime.json`;
    this.#importLegacy = options.importLegacy;
    this.#onRecovery = options.onRecovery;
    this.#onPollingError = options.onPollingError;
    this.#pollingIntervalMs = options.pollingIntervalMs ?? 1_000;
    if (this.#pollingIntervalMs !== false && this.#pollingIntervalMs <= 0) {
      throw new Error("Personal Provider Config pollingIntervalMs 必须大于 0");
    }
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await this.#readCurrent();
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } catch (error) {
      const snapshot = this.#recoverInvalidFile(error);
      this.#observedRevision ??= snapshot.revision;
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    try {
      const snapshot = await withFileLock(this.#filePath, async () => {
        const current = await this.#readLocked();
        const next = transform(current);
        const update = Object.freeze({
          providers: next.providers,
          models: next.models,
          providerOrder: next.providerOrder,
          defaultModelSelection: next.defaultModelSelection,
        });
        const committed = await this.#writeLocked(update);
        const savedProviderId = next.savedProviderId?.trim() || undefined;
        const saveGenerations = savedProviderId
          ? Object.freeze({
              ...current.saveGenerations,
              [savedProviderId]: randomUUID(),
            })
          : current.saveGenerations;
        if (savedProviderId) {
          // 修复：设置 Host 与 Agent 分属不同进程，供应商代次必须落到共享 sidecar，
          // 不能只由写入进程记忆最后一次保存者。
          await writeSaveGenerations(this.#stateFilePath, saveGenerations ?? {});
        }
        const snapshot = snapshotFromUpdate(committed, saveGenerations);
        // 原子写可能产生多次文件系统事件。写入完成后先记录内容版本，
        // polling 随后读取到同一版本时不会再次发布失效通知。
        this.#observedRevision = snapshot.revision;
        this.#observedSaveGenerationsRevision = saveGenerationsRevision(snapshot.saveGenerations);
        return snapshot;
      });
      this.#emit("updated");
      return snapshot;
    } finally {
      this.#ensurePolling();
    }
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollingTimer) clearTimeout(this.#pollingTimer);
    this.#pollingTimer = null;
    this.#listeners.clear();
  }

  async #readCurrent(): Promise<ProviderConfigLayerSnapshot> {
    // 多个进程纯读取也争排他锁，慢 IO 会把轮询放大成锁超时。
    // 正式文件通过同目录临时文件原子替换，纯读可以直接观察已提交的完整文档。
    const [file, saveGenerations] = await Promise.all([
      readJsonFileIfExists(this.#filePath),
      readSaveGenerations(this.#stateFilePath),
    ]);
    if (file === null && !this.#importLegacy)
      return snapshotFromUpdate(emptyUpdate(), saveGenerations);
    if (file !== null) {
      const update = decodeProviderConfigFile(file.value);
      if (JSON.stringify(file.value) === JSON.stringify(encodeProviderConfigFile(update))) {
        return snapshotFromUpdate(update, saveGenerations);
      }
    }
    // 导入和规范化仍会写盘。拿锁后必须重读，不能用加锁前的旧内容覆盖其他 writer。
    return withFileLock(this.#filePath, () => this.#readLocked());
  }

  async #readLocked(): Promise<ProviderConfigLayerSnapshot> {
    const [file, saveGenerations] = await Promise.all([
      readJsonFileIfExists(this.#filePath),
      readSaveGenerations(this.#stateFilePath),
    ]);
    if (file === null) {
      const imported = await this.#importLegacy?.();
      const update = imported ?? emptyUpdate();
      if (imported) return snapshotFromUpdate(await this.#writeLocked(update), saveGenerations);
      return snapshotFromUpdate(update, saveGenerations);
    }

    const update = decodeProviderConfigFile(file.value);
    const encoded = encodeProviderConfigFile(update);
    if (JSON.stringify(file.value) !== JSON.stringify(encoded)) {
      await this.#writeLocked(update);
      return snapshotFromUpdate(update, saveGenerations);
    }
    return snapshotFromUpdate(update, saveGenerations);
  }

  async #writeLocked(update: ProviderConfigLayerUpdate): Promise<ProviderConfigLayerUpdate> {
    // 同一入口写入规则与默认选择；先严格验证整份结果，不能落盘后才发现来源越权/坏值。
    // 使用与读取相同的规范形态再计算版本，避免外层规则键顺序使“写成功”的版本读回就变化。
    const canonical = decodeProviderConfigFile(encodeProviderConfigFile(update));
    const encoded = encodeProviderConfigFile(canonical);
    await atomicWritePrivateTextFile(this.#filePath, JSON.stringify(encoded, null, 2));
    this.#writeGeneration += 1;
    return canonical;
  }

  async #readPollingSnapshot(): Promise<ProviderConfigLayerSnapshot> {
    const [file, saveGenerations] = await Promise.all([
      readJsonFileIfExists(this.#filePath),
      readSaveGenerations(this.#stateFilePath),
    ]);
    if (file === null) return snapshotFromUpdate(emptyUpdate(), saveGenerations);
    return snapshotFromUpdate(decodeProviderConfigFile(file.value), saveGenerations);
  }

  #recoverInvalidFile(error: unknown): ProviderConfigLayerSnapshot {
    // 正式文件无效时必须原样保留，不能备份后覆盖成空配置；本进程仅以内存空
    // Overlay 降级，等待用户修复原文件。
    this.#reportRecovery({ error });
    return snapshotFromUpdate(emptyUpdate());
  }

  #reportRecovery(event: PersonalProviderConfigRecoveryEvent): void {
    try {
      this.#onRecovery?.(Object.freeze(event));
    } catch {
      // 观测回调不是配置事实，不能反向阻断恢复。
    }
  }

  #ensurePolling(): void {
    // 轮询在飞时 timer 已清空；显式 read/update 的 finally 不能再排入第二轮。
    if (
      this.#pollingIntervalMs === false ||
      this.#pollingTimer ||
      this.#pollingInFlight ||
      this.#disposed
    )
      return;
    this.#pollingTimer = setTimeout(() => {
      this.#pollingTimer = null;
      void this.#pollOnce();
    }, this.#pollingIntervalMs);
    this.#pollingTimer.unref?.();
  }

  async #pollOnce(): Promise<void> {
    this.#pollingInFlight = true;
    const writeGeneration = this.#writeGeneration;
    try {
      const snapshot = await this.#readPollingSnapshot();
      // 内容哈希相同的重新保存不会改变 revision，但 sidecar 代次会变；Agent 不能等 replace。
      const saveGenerationsRevisionValue = saveGenerationsRevision(snapshot.saveGenerations);
      if (
        !this.#disposed &&
        saveGenerationsRevisionValue !== this.#observedSaveGenerationsRevision
      ) {
        this.#observedSaveGenerationsRevision = saveGenerationsRevisionValue;
        this.#emit("save-generation");
      }
      // 去掉读锁后，旧轮询可能晚于本进程保存返回；丢弃它，避免版本倒退及重复通知。
      if (writeGeneration !== this.#writeGeneration) return;
      this.#pollingErrorActive = false;
      if (this.#disposed || snapshot.revision === this.#observedRevision) return;
      this.#observedRevision = snapshot.revision;
      this.#emit("poll-changed");
    } catch (error) {
      // 成功保存也使旧轮询的失败失效，不能在新版本之后再发布旧读操作的故障。
      if (this.#disposed || writeGeneration !== this.#writeGeneration) return;
      if (!this.#pollingErrorActive) {
        this.#pollingErrorActive = true;
        try {
          this.#onPollingError?.(error);
        } catch {
          // 观测回调不能反向阻断下一轮自愈。
        }
        this.#emit("poll-error");
      }
    } finally {
      this.#pollingInFlight = false;
      this.#ensurePolling();
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodePersonalProviderConfigRepository 已 dispose");
  }
}

export function createNodePersonalProviderConfigRepository(
  options: NodePersonalProviderConfigRepositoryOptions,
): NodePersonalProviderConfigRepository {
  return new NodePersonalProviderConfigRepository(options);
}

async function readJsonFileIfExists(filePath: string): Promise<{ readonly value: unknown } | null> {
  try {
    return { value: JSON.parse(await readFile(filePath, "utf8")) as unknown };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
  });
}

function snapshotFromUpdate(
  update: ProviderConfigLayerUpdate,
  saveGenerations?: Readonly<Record<string, string>>,
): ProviderConfigLayerSnapshot {
  const content = JSON.stringify(encodeProviderConfigFile(update));
  return Object.freeze({
    revision: createHash("sha256").update(content).digest("hex"),
    ...(saveGenerations === undefined ? {} : { saveGenerations }),
    providers: update.providers,
    models: update.models,
    // 快照必须与 revision 对应的磁盘内容一致；补空数组会让未声明排序的文件在 CAS 时误报变化。
    providerOrder: update.providerOrder,
    defaultModelSelection: update.defaultModelSelection,
  });
}

async function readSaveGenerations(filePath: string): Promise<Readonly<Record<string, string>>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.saveGenerations)) {
      return Object.freeze({});
    }
    const entries = Object.entries(parsed.saveGenerations).flatMap(([providerId, generation]) =>
      providerId.trim() && typeof generation === "string" && generation.trim()
        ? [[providerId, generation] as const]
        : [],
    );
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (isFileNotFound(error) || error instanceof SyntaxError) return Object.freeze({});
    throw error;
  }
}

async function writeSaveGenerations(
  filePath: string,
  saveGenerations: Readonly<Record<string, string>>,
): Promise<void> {
  await atomicWritePrivateTextFile(
    filePath,
    JSON.stringify({ schemaVersion: 1, saveGenerations }, null, 2),
  );
}

function saveGenerationsRevision(
  saveGenerations: Readonly<Record<string, string>> | undefined,
): string {
  return JSON.stringify(saveGenerations ?? {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
