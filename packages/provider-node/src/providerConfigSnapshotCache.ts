import { stat } from "node:fs/promises";
import type { ProviderConfigLayerSnapshot } from "@lcode/provider";

/** Repository 私有的已校验快照缓存；配置与保存代次文件共同决定身份。 */
export class ProviderConfigSnapshotCache {
  #cached:
    | { signature: string; snapshot: ProviderConfigLayerSnapshot; canonical: boolean }
    | undefined;
  #inFlight: { promise: Promise<ProviderConfigLayerSnapshot>; canonical: boolean } | undefined;
  #generation = 0;

  constructor(private readonly paths: readonly string[]) {}

  read(
    load: () => Promise<ProviderConfigLayerSnapshot>,
    canonical = false,
  ): Promise<ProviderConfigLayerSnapshot> {
    if (this.#inFlight) {
      if (!canonical || this.#inFlight.canonical) return this.#inFlight.promise;
      return this.#inFlight.promise.then(() => this.read(load, canonical));
    }
    const promise = this.#readOnce(load, canonical);
    this.#inFlight = { promise, canonical };
    void promise
      .finally(() => {
        if (this.#inFlight?.promise === promise) this.#inFlight = undefined;
      })
      .catch(() => undefined);
    return promise;
  }

  clear(): void {
    this.#generation++;
    this.#cached = undefined;
    this.#inFlight = undefined;
  }

  async #readOnce(
    load: () => Promise<ProviderConfigLayerSnapshot>,
    canonical: boolean,
  ): Promise<ProviderConfigLayerSnapshot> {
    const generation = this.#generation;
    const before = await this.#signature();
    if (this.#cached?.signature === before && (!canonical || this.#cached.canonical))
      return this.#cached.snapshot;
    const snapshot = await load();
    const after = await this.#signature();
    // 原子替换/外部 writer 可能与读取重叠；只有稳定文档才可跳过后续全量解析。
    if (before === after && generation === this.#generation)
      this.#cached = { signature: after, snapshot, canonical };
    return snapshot;
  }

  async #signature(): Promise<string> {
    const parts = await Promise.all(
      this.paths.map(async (path) => {
        try {
          const value = await stat(path, { bigint: true });
          return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          throw error;
        }
      }),
    );
    return parts.join("|");
  }
}
