import { randomUUID } from "node:crypto";
import {
  RoutingScheduler,
  type ProviderRoutingPolicy,
  type ProviderApiKey,
  type RoutingCandidate,
  type RoutingRequest,
  type RoutingWindow,
  type RoutingFinish,
} from "@lcode/provider";
import { apiKeyQuotaSnapshotSchema, type ApiKeyQuotaSnapshot } from "@lcode/shared";

import { apiKeyRoutingPolicy } from "./api-key-routing-policy.js";
const WORK_QUANTUM = 4096;
/** 原池内的投影；共享资源身份由配置明确声明，不从显示名称或 URL 猜测。 */
export class ApiKeyRouting {
  constructor(
    private readonly coordinated = false,
    private readonly now: () => number = Date.now,
  ) {}
  private scheduler?: RoutingScheduler;
  private signature?: string;
  private configured = false;
  private policyInput?: ProviderRoutingPolicy | null;
  private keys: readonly ProviderApiKey[] = [];
  private readonly byId = new Map<string, ProviderApiKey>();
  private readonly pools = new Set<string>();
  private readonly windows = new Map<string, RoutingWindow[]>();
  private revision = 0;
  private catalogIds?: readonly string[];
  private unavailable: (id: string, modelKey?: string) => boolean = () => false;
  private context?: RoutingRequest;
  private availableAt: (id: string, modelKey?: string) => number | undefined = () => undefined;
  get enabled(): boolean {
    return Boolean(this.policyInput && this.scheduler);
  }

  configure(
    policy?: ProviderRoutingPolicy | null,
    keys: readonly ProviderApiKey[] = this.keys,
  ): void {
    if (this.configured && policy === this.policyInput && keys === this.keys) return;
    this.configured = true;
    this.policyInput = policy;
    const catalogChanged = keys !== this.keys;
    if (catalogChanged) {
      this.keys = keys;
      this.byId.clear();
      this.pools.clear();
      for (const key of keys) {
        this.byId.set(key.id, key);
        if (key.routing?.quotaPoolId) this.pools.add(key.routing.quotaPoolId);
      }
    }
    const effective = policy ? apiKeyRoutingPolicy(policy, keys) : policy;
    const signature = JSON.stringify(effective ?? null);
    if (this.signature === signature && !catalogChanged) return;
    this.signature = signature;
    if (!policy) {
      // 开关只撤销未派发权限，不能洗掉同 owner 的在途和共享额度借记。
      this.scheduler?.invalidatePending();
      return;
    }
    if (this.scheduler) this.scheduler.setPolicy(effective!);
    else this.scheduler = new RoutingScheduler(effective!, { now: this.now });
    this.catalogIds = undefined;
  }

  private owner(key: ProviderApiKey): string {
    return JSON.stringify(
      key.routing?.quotaPoolId ? ["pool", key.routing.quotaPoolId] : ["key", key.id],
    );
  }

  reserve(
    ids: readonly string[],
    unavailable: (id: string, modelKey?: string) => boolean,
    request?: RoutingRequest,
    availableAt: (id: string, modelKey?: string) => number | undefined = () => undefined,
  ) {
    if (!this.enabled || !this.scheduler) return undefined;
    this.unavailable = unavailable;
    this.availableAt = availableAt;
    if (this.catalogIds !== ids) {
      this.scheduler.setDirectory(ids, (id, input) => this.candidate(id, input?.modelKey));
      this.catalogIds = ids;
    }
    const context = request ?? {
      attemptId: randomUUID(),
      scopeKey: randomUUID(),
      workUnits: WORK_QUANTUM,
    };
    this.context = context;
    const lease = this.scheduler.reserveIndexed(context);
    const chosen = this.candidate(lease.routeId, context.modelKey);
    const selectedKey = this.byId.get(lease.routeId)!;
    const ttl = selectedKey.routing?.cacheGroupId ? selectedKey.routing.cacheTtlMs : undefined;
    return {
      ...lease,
      sharedQuotaInput:
        this.coordinated && selectedKey.routing?.quotaPoolId
          ? {
              poolId: selectedKey.routing.quotaPoolId,
              reserveRules: this.policyInput?.reserveRules?.filter(
                (rule) =>
                  !chosen.windows.some(
                    (window) => !window.shared && window.resourceId === rule.resourceId,
                  ),
              ),
              keyId: selectedKey.id,
              maxInFlight: Math.min(
                this.policyInput?.maxInFlightPerCandidate ?? 2,
                chosen.windows.length ? Infinity : 1,
              ),
              request: {
                createdAt: lease.createdAt,
                attemptId: context.attemptId,
                scopeKey: context.scopeKey,
                modelKey: context.modelKey,
                tokens: context.tokens,
                demands: context.demands,
              },
              windows: this.sharedWindows(selectedKey.routing.quotaPoolId),
            }
          : undefined,
      sharedQuotaWindows: () => this.sharedWindows(selectedKey.routing?.quotaPoolId),
      observeHeaders: (headers: Headers) => this.observe(lease.routeId, headers, selectedKey),
      finish: (result: RoutingFinish) =>
        lease.finish({ ...result, ...(ttl ? { cacheUntil: this.now() + ttl } : {}) }),
      observeUsage: (result: RoutingFinish) => {
        const actualDemands: Record<string, number> = { ...result.actualDemands };
        const usage = result.tokens;
        const total =
          usage?.total ??
          (usage?.input !== undefined && usage.output !== undefined
            ? usage.input + usage.output
            : undefined);
        for (const window of chosen.windows) {
          const amount =
            window.unit === "tokens"
              ? total
              : window.unit === "input_tokens"
                ? usage?.input
                : window.unit === "output_tokens"
                  ? usage?.output
                  : undefined;
          if (amount !== undefined) actualDemands[window.resourceId] = amount;
        }
        lease.observeUsage({
          ...result,
          ...(Object.keys(actualDemands).length ? { actualDemands } : {}),
        });
      },
    };
  }

  observeQuota(input: ApiKeyQuotaSnapshot): void {
    this.applyQuota(input);
  }
  private applyQuota(input: ApiKeyQuotaSnapshot, retainedOwner = false): void {
    const snapshot = apiKeyQuotaSnapshotSchema.parse(input);
    if (!retainedOwner && snapshot.keyId && !this.byId.has(snapshot.keyId))
      throw new Error("Unknown routing key");
    if (!retainedOwner && snapshot.poolId && !this.pools.has(snapshot.poolId))
      throw new Error("Unknown routing pool");
    const owner = JSON.stringify(
      snapshot.poolId ? ["pool", snapshot.poolId] : ["key", snapshot.keyId],
    );
    const prior = this.windows.get(owner) ?? [];
    const next = snapshot.windows.map((window) => ({
      ...window,
      shared: Boolean(snapshot.poolId),
      coordinated: Boolean(snapshot.poolId) && this.coordinated,
      resourceId: JSON.stringify([owner, window.resourceId]),
    }));
    const merged = new Map(prior.map((window) => [window.resourceId, window]));
    for (const window of next) {
      // 同一修订重放不能改写已确认余额，否则重复快照可绕过耗尽判断。
      if ((merged.get(window.resourceId)?.revision ?? -1) >= window.revision) continue;
      merged.set(window.resourceId, window);
      this.scheduler?.observeQuota(window);
    }
    this.windows.set(owner, [...merged.values()]);
    if (snapshot.keyId) this.scheduler?.touchDirectory(snapshot.keyId);
    if (snapshot.poolId) this.scheduler?.touchQuotaGroup(snapshot.poolId);
  }

  observe(id: string, headers: Headers, retainedKey?: ProviderApiKey): void {
    const key = retainedKey ?? this.byId.get(id);
    if (!key) return;
    const windows: RoutingWindow[] = [];
    for (const unit of ["requests", "tokens"] as const) {
      const rawRemaining = headers.get(`x-ratelimit-remaining-${unit}`),
        rawLimit = headers.get(`x-ratelimit-limit-${unit}`);
      if (rawRemaining === null || rawLimit === null) continue;
      const remaining = Number(rawRemaining),
        limit = Number(rawLimit);
      if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(limit) || limit <= 0)
        continue;
      const reset = headers.get(`x-ratelimit-reset-${unit}`);
      const resetAt = reset && /^\d{4}-/u.test(reset) ? Date.parse(reset) : NaN;
      windows.push({
        resourceId: unit,
        instanceId: Number.isFinite(resetAt) ? String(resetAt) : "unverified-period",
        revision: ++this.revision,
        kind: "rate",
        quality: "fresh",
        remaining,
        limit,
        unit,
        ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      });
    }
    if (windows.length)
      this.applyQuota(
        {
          ...(key.routing?.quotaPoolId ? { poolId: key.routing.quotaPoolId } : { keyId: id }),
          windows,
        },
        Boolean(retainedKey),
      );
  }

  private candidate(id: string, modelKey?: string): RoutingCandidate {
    const key = this.byId.get(id)!;
    const privateWindows = this.windows.get(JSON.stringify(["key", id])) ?? [];
    return {
      id,
      generation: "pool",
      availableAt: this.availableAt(id, modelKey),
      portability: "portable",
      quotaGroupId: key.routing?.quotaPoolId,
      cacheGroupId: key.routing?.cacheGroupId,
      windows: key.routing?.quotaPoolId
        ? [...privateWindows, ...(this.windows.get(this.owner(key)) ?? [])]
        : privateWindows,
      ...(key.enabled === false
        ? { unavailable: "key-disabled" }
        : this.unavailable(id, modelKey)
          ? { unavailable: "route-cooling" }
          : {}),
    };
  }
  sharedWindows(poolId?: string): RoutingWindow[] {
    return (this.windows.get(JSON.stringify(["pool", poolId])) ?? []).map(
      ({ shared: _shared, coordinated: _coordinated, ...window }) => window,
    );
  }
  recoveryResources(id: string, modelKey?: string) {
    const key = JSON.stringify(["key", id]);
    const model = JSON.stringify(["model", id, modelKey ?? null]);
    const pool = this.byId.get(id)?.routing?.quotaPoolId;
    const shared = pool
      ? this.coordinated
        ? undefined
        : JSON.stringify(["pool", pool])
      : "provider";
    return {
      key,
      model,
      shared,
      all: ["provider", key, model, ...(shared && shared !== "provider" ? [shared] : [])],
    };
  }
  touch(id: string): void {
    this.scheduler?.touchDirectory(id);
  }
  readDiagnostics(input: { offset?: number; limit?: number; revision?: number } = {}) {
    const offset = input.offset ?? 0,
      limit = input.limit ?? 50;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error("Invalid routing diagnostic page");
    const revision = this.scheduler?.routingRevision ?? 0;
    if (input.revision !== undefined && input.revision !== revision)
      throw new Error("policy-conflict");
    const context = this.context ?? { attemptId: "preview", scopeKey: "preview" };
    const items = this.keys.slice(offset, offset + limit).map((key) => {
      const candidate = this.candidate(key.id, context.modelKey);
      const plan = this.enabled ? this.scheduler?.plan([candidate], context) : undefined;
      return {
        keyId: key.id,
        inFlight: this.scheduler?.routingInFlight(key.id) ?? 0,
        enabled: key.enabled !== false,
        quotaPoolId: key.routing?.quotaPoolId,
        cacheGroupId: key.routing?.cacheGroupId,
        strategy: plan?.effectiveStrategy,
        fallbackReason: plan?.fallbackReason,
        reason: plan?.excluded[key.id] ?? plan?.reason ?? "legacy",
        windows: candidate.windows.map((window) => ({
          ...window,
          available: plan?.available[window.resourceId],
          availableSource: "local-preview" as const,
        })),
        tokenEstimate: context.tokens,
      };
    });
    return {
      revision,
      source: "executor-preview" as const,
      total: this.keys.length,
      offset,
      nextOffset: offset + limit < this.keys.length ? offset + limit : undefined,
      items,
      index: this.scheduler?.indexDiagnostics(),
    };
  }
  readRuntimeDiagnostics() {
    return this.scheduler?.readDiagnostics() ?? null;
  }
  dispose(): void {
    this.scheduler?.dispose();
    this.windows.clear();
  }
}
