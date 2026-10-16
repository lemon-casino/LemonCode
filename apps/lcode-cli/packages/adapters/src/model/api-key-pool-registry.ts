import { createHash } from "node:crypto";
import {
  RateLimitWindow,
  resolveApiKeyAccessKeys,
  RoutingError,
  type ProviderApiKey,
  type ApiKeyAccessConfigObject,
  type ProviderRoutingPolicy,
  type SharedQuotaCoordinator,
} from "@lcode/provider";
import type { ApiKeyQuotaSnapshot } from "@lcode/shared";
import { ApiKeyPool } from "./api-key-pool-owner.js";
import { ApiKeySharedQuotaClient } from "./api-key-shared-client.js";

/** 每个执行上下文的唯一池目录；旧绑定持有旧池，目录不强持有所有历史密钥代次。 */
export class ApiKeyPoolRegistry {
  private readonly quota?: ApiKeySharedQuotaClient;
  constructor(coordinator?: SharedQuotaCoordinator) {
    if (coordinator) this.quota = new ApiKeySharedQuotaClient(coordinator);
  }
  readSharedQuota(providerId: string, poolId: string) {
    return this.quota?.coordinator.inspect(providerId, poolId) ?? Promise.resolve(null);
  }
  drain(): Promise<void> {
    return this.quota?.drain() ?? Promise.resolve();
  }
  private readonly normalized = new WeakMap<object, readonly ProviderApiKey[]>();
  private readonly signatures = new WeakMap<readonly ProviderApiKey[], string>();
  private readonly primary = new WeakMap<readonly ProviderApiKey[], { key?: ProviderApiKey }>();
  private readonly pools = new Map<string, WeakRef<ApiKeyPool>>();
  private readonly current = new Map<string, ApiKeyPool>();
  private readonly windows = new Map<string, RateLimitWindow>();
  private readonly finalizer = new FinalizationRegistry<string>((slot) => {
    if (!this.pools.get(slot)?.deref()) this.pools.delete(slot);
  });

  observeSharedQuota(
    providerId: string,
    snapshot: ApiKeyQuotaSnapshot,
    coversThroughSeq?: number,
  ): Promise<void> {
    const pool = this.current.get(providerId);
    if (!pool) throw new RoutingError("owner-stale");
    return pool.observeSharedQuota(snapshot, coversThroughSeq);
  }
  observeQuota(providerId: string, snapshot: ApiKeyQuotaSnapshot): void {
    const pool = this.current.get(providerId);
    if (!pool) throw new Error("No active API Key pool");
    pool.observeRoutingQuota(snapshot);
  }
  readDiagnostics(providerId: string, input?: Parameters<ApiKeyPool["readRoutingDiagnostics"]>[0]) {
    return this.current.get(providerId)?.readRoutingDiagnostics(input) ?? null;
  }

  readRuntimeDiagnostics(
    providerId: string,
    input?: Parameters<ApiKeyPool["readRoutingDiagnostics"]>[0],
  ) {
    return this.current.get(providerId)?.readRuntimeDiagnostics(input) ?? Promise.resolve(null);
  }

  keysFor(access: ApiKeyAccessConfigObject): readonly ProviderApiKey[] {
    if (!Object.isFrozen(access)) return resolveApiKeyAccessKeys(access);
    const cached = this.normalized.get(access);
    if (cached) return cached;
    const keys = resolveApiKeyAccessKeys(access);
    this.normalized.set(access, keys);
    return keys;
  }

  primaryKeyFor(keys: readonly ProviderApiKey[]): ProviderApiKey | undefined {
    let entry = this.primary.get(keys);
    if (!entry) {
      entry = { key: keys.find((key) => key.enabled !== false && key.apiKey.trim().length > 0) };
      this.primary.set(keys, entry);
    }
    return entry.key;
  }

  get(
    providerId: string,
    generation: string | undefined,
    keys: readonly ProviderApiKey[],
    routing?: ProviderRoutingPolicy | null,
  ): ApiKeyPool {
    let signature = this.signatures.get(keys);
    if (!signature) {
      const hash = createHash("sha256");
      for (const key of keys)
        hash.update(JSON.stringify([key.id, key.enabled !== false, key.apiKey]));
      signature = hash.digest("hex");
      this.signatures.set(keys, signature);
    }
    const slot = JSON.stringify([providerId, generation ?? null, signature]);
    let pool = this.pools.get(slot)?.deref();
    if (!pool) {
      let window = this.windows.get(providerId);
      if (!window) {
        window = new RateLimitWindow();
        this.windows.set(providerId, window);
      }
      pool = new ApiKeyPool(
        keys,
        undefined,
        window,
        this.quota ? { providerId, client: this.quota } : undefined,
      );
      this.pools.set(slot, new WeakRef(pool));
      this.finalizer.register(pool, slot);
    }
    pool.configureRouting({ version: 1, strategy: routing?.strategy ?? "reliable-first" }, keys);
    this.current.set(providerId, pool);
    return pool;
  }

  dispose(): void {
    for (const window of this.windows.values()) window.dispose();
    this.windows.clear();
    for (const reference of this.pools.values()) reference.deref()?.dispose();
    this.pools.clear();
    this.current.clear();
  }
}
