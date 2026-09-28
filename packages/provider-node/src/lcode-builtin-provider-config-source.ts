import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ProviderConfigLayerSnapshot, ProviderSource } from "@lcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  decodeLCodeBuiltinRelease,
  encodeLCodeBuiltinRelease,
  serializeLCodeBuiltinRelease,
  type LCodeBuiltinRelease,
} from "./lcode-builtin-release.js";

export interface NodeLCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly activeFilePath?: string;
  readonly watch?: boolean;
}

export type ApplyLCodeBuiltinReleaseResult = "updated" | "unchanged" | "stale";

/** Bundled、Active/LKG 与 Remote 共用同一 Release，并最终发布为现有 Config Snapshot。 */
export class NodeLCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #bundledFilePath: string;
  readonly #activeFilePath: string;
  readonly #sourceKey: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedSignature: string | null = null;
  #watchRefresh = Promise.resolve();
  #disposed = false;

  constructor(options: NodeLCodeBuiltinProviderConfigSourceOptions) {
    const bundledFilePath = options.bundledFilePath.trim();
    if (!bundledFilePath) throw new Error("LCode Built-in bundledFilePath 不能为空");
    this.#bundledFilePath = bundledFilePath;
    this.#activeFilePath = options.activeFilePath?.trim() || bundledFilePath;
    // 旧标识只有发布序号，不同 Endpoint 同序号会让 Registry 误复用上一来源。
    // Active 路径已含规范化 Endpoint 隔离范围；Worker 收到同一路径，不另拼账号事实。
    this.#sourceKey = createHash("sha256").update(resolve(this.#activeFilePath)).digest("hex");
    this.#watchEnabled = options.watch !== false;
  }

  get activeFilePath(): string {
    return this.#activeFilePath;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    let release: LCodeBuiltinRelease;
    try {
      await this.#ensureWatcher();
      release = await withFileLock(this.#activeFilePath, () => this.#readAndMaterializeLocked());
    } catch {
      // Active 只是可丢弃缓存，目录锁、监听或原子物化失败不能阻断
      // Bundled 基线。缓存边界不可用时绕过 Active；Bundled 自身无效仍会在这里抛错。
      release = selectReleaseCandidate(await readReleaseCandidate(this.#bundledFilePath), null);
    }
    this.#observedSignature ??= signatureOf(release);
    return snapshotFromRelease(release, this.#sourceKey);
  }

  async applyRemoteRelease(release: LCodeBuiltinRelease): Promise<ApplyLCodeBuiltinReleaseResult> {
    this.#assertNotDisposed();
    await this.#ensureWatcher();
    const result = await withFileLock(this.#activeFilePath, async () => {
      this.#assertNotDisposed();
      const current = await this.#readAndMaterializeLocked();
      this.#assertNotDisposed();
      if (release.revision < current.revision) return "stale" as const;
      if (release.revision === current.revision) {
        if (serializeLCodeBuiltinRelease(release) === serializeLCodeBuiltinRelease(current)) {
          return "unchanged" as const;
        }
        throw new Error(`LCode Built-in 相同 revision ${release.revision} 对应不同内容`);
      }
      await this.#writeActiveLocked(release);
      this.#observedSignature = signatureOf(release);
      return "updated" as const;
    });
    if (result === "updated" && !this.#disposed) this.#emit("remote-updated");
    return result;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  async #readAndMaterializeLocked(): Promise<LCodeBuiltinRelease> {
    const [bundled, active] = await Promise.all([
      readReleaseCandidate(this.#bundledFilePath),
      this.#activeFilePath === this.#bundledFilePath
        ? Promise.resolve(null)
        : readReleaseCandidate(this.#activeFilePath),
    ]);
    const selected = selectReleaseCandidate(bundled, active);
    if (this.#activeFilePath !== this.#bundledFilePath) {
      const activeSignature = active?.release ? signatureOf(active.release) : null;
      if (activeSignature !== signatureOf(selected)) await this.#writeActiveLocked(selected);
    }
    return selected;
  }

  async #writeActiveLocked(release: LCodeBuiltinRelease): Promise<void> {
    this.#assertNotDisposed();
    await atomicWritePrivateTextFile(
      this.#activeFilePath,
      JSON.stringify(encodeLCodeBuiltinRelease(release), null, 2),
    );
  }

  async #ensureWatcher(): Promise<void> {
    await mkdir(dirname(this.#activeFilePath), { recursive: true });
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    const target = basename(this.#activeFilePath);
    this.#watcher = watch(dirname(this.#activeFilePath), (_eventType, fileName) => {
      if (fileName === null || fileName.toString() === target) this.#scheduleWatchRefresh();
    });
    this.#watcher.on("error", () => this.#emit("watch-error"));
  }

  #scheduleWatchRefresh(): void {
    this.#watchRefresh = this.#watchRefresh.then(async () => {
      if (this.#disposed) return;
      try {
        const release = await withFileLock(this.#activeFilePath, () =>
          this.#readAndMaterializeLocked(),
        );
        const signature = signatureOf(release);
        if (this.#disposed || signature === this.#observedSignature) return;
        this.#observedSignature = signature;
        this.#emit("file-changed");
      } catch {
        this.#emit("watch-error");
      }
    });
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeLCodeBuiltinProviderConfigSource 已 dispose");
  }
}

export function createNodeLCodeBuiltinProviderConfigSource(
  options: NodeLCodeBuiltinProviderConfigSourceOptions,
): NodeLCodeBuiltinProviderConfigSource {
  return new NodeLCodeBuiltinProviderConfigSource(options);
}

interface ReleaseCandidate {
  readonly release?: LCodeBuiltinRelease;
  readonly error?: unknown;
}

async function readReleaseCandidate(filePath: string): Promise<ReleaseCandidate | null> {
  try {
    return { release: decodeLCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8"))) };
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return { error };
  }
}

function selectReleaseCandidate(
  bundled: ReleaseCandidate | null,
  active: ReleaseCandidate | null,
): LCodeBuiltinRelease {
  if (
    bundled?.release &&
    active?.release &&
    bundled.release.revision === active.release.revision &&
    serializeLCodeBuiltinRelease(bundled.release) !== serializeLCodeBuiltinRelease(active.release)
  ) {
    // 同 revision 冲突属于 Active 缓存失效，不能反向使可信 Bundled 无法启动。
    // 返回 Bundled 后调用方会在能够写入时原子替换 Active。
    return bundled.release;
  }
  const valid = [bundled?.release, active?.release].filter(
    (candidate): candidate is LCodeBuiltinRelease => candidate !== undefined,
  );
  if (valid.length === 0) {
    throw new AggregateError(
      [bundled?.error, active?.error].filter((error) => error !== undefined),
      "Bundled 与 Active LCode Built-in Release 均不可用",
    );
  }
  return valid.reduce((newest, candidate) =>
    candidate.revision > newest.revision ? candidate : newest,
  );
}

function snapshotFromRelease(
  release: LCodeBuiltinRelease,
  sourceKey: string,
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: `lcode-builtin:${release.revision}:${sourceKey}`,
    providers: release.config.providers,
    providerTemplates: release.config.providerTemplates,
    models: release.config.modelConfigRules,
  });
}

function signatureOf(release: LCodeBuiltinRelease): string {
  return `${release.revision}:${serializeLCodeBuiltinRelease(release)}`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
