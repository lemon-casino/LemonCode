import {
  runtimeEnvironmentGarbageCollectionParamsSchema,
  runtimeEnvironmentGarbageCollectionResultSchema,
  runtimeEnvironmentResourceScanParamsSchema,
  runtimeEnvironmentResourceSummarySchema,
  type FrozenManifest,
  type RuntimeEnvironmentGarbageCollectionParams,
  type RuntimeEnvironmentGarbageCollectionResult,
  type RuntimeEnvironmentResourceScanParams,
  type RuntimeEnvironmentResourceScanResult,
  type RuntimeEnvironmentResourceSummary,
} from "@lcode/shared";
import { assertEnvironmentScope } from "./preparationAdmission.js";
import {
  identityKeyOf,
  operationIdFor,
  scopeKeyHash,
  type RuntimeEnvironmentStore,
} from "./ports.js";

export interface ResourceScanBudget {
  maxEntries: number;
  maxDurationMs: number;
}
export const DEFAULT_RESOURCE_SCAN_BUDGET: Readonly<ResourceScanBudget> = Object.freeze({
  maxEntries: 2_000,
  maxDurationMs: 200,
});
export const MAX_RESOURCE_SCAN_BUDGET: Readonly<ResourceScanBudget> = Object.freeze({
  maxEntries: 20_000,
  maxDurationMs: 2_000,
});

export function normalizeResourceScanBudget(budget: ResourceScanBudget): ResourceScanBudget {
  if (
    !budget ||
    !Number.isSafeInteger(budget.maxEntries) ||
    budget.maxEntries <= 0 ||
    !Number.isSafeInteger(budget.maxDurationMs) ||
    budget.maxDurationMs <= 0
  ) {
    throw new Error("Invalid resource scan budget");
  }
  return {
    maxEntries: Math.min(budget.maxEntries, MAX_RESOURCE_SCAN_BUDGET.maxEntries),
    maxDurationMs: Math.min(budget.maxDurationMs, MAX_RESOURCE_SCAN_BUDGET.maxDurationMs),
  };
}

/** 仅 adapter 内部的候选清单；本机路径不加入公共 GC wire 结果。 */
export interface ResourceCollectionCandidate {
  path: string;
  kind: "tool" | "download";
  state: "eligible" | "protected" | "deleted";
}
export interface ResourceCollectionParams {
  operationId: string;
  budget: ResourceScanBudget;
  dryRun: boolean;
  protectedToolPaths?: readonly string[];
}
export interface ResourceCollectionResult extends RuntimeEnvironmentGarbageCollectionResult {
  candidates: ResourceCollectionCandidate[];
}

/** 资源事实由环境 owner 决策；目录、引用扫描、安装锁与 GC journal 只由 adapter 执行。 */
export interface ResourcePort {
  ensure(environmentId: string): Promise<NonNullable<FrozenManifest["resources"]>>;
  scan(
    environmentId: string,
    budget: ResourceScanBudget,
  ): Promise<RuntimeEnvironmentResourceSummary>;
  clearRebuildable(environmentId: string): Promise<void>;
  /** 仅明确 Worktree discard、消费者结算后调用；包含私有 data，不触碰共享 stores。 */
  discard(environmentId: string): Promise<void>;
  collect(params: ResourceCollectionParams): Promise<ResourceCollectionResult>;
}

export function createResourceControl(options: {
  store: RuntimeEnvironmentStore;
  resources: ResourcePort;
  stamp?: () => string;
}): {
  resourceSummary(
    params: RuntimeEnvironmentResourceScanParams,
  ): Promise<RuntimeEnvironmentResourceScanResult>;
  garbageCollect(
    params: RuntimeEnvironmentGarbageCollectionParams,
  ): Promise<RuntimeEnvironmentGarbageCollectionResult>;
} {
  const { store, resources } = options;
  const stamp = options.stamp ?? (() => new Date().toISOString());
  return {
    async resourceSummary(input) {
      const params = runtimeEnvironmentResourceScanParamsSchema.parse(input);
      const budget = normalizeResourceScanBudget(params.budget);
      const environmentId =
        params.environmentId ??
        (await store.readOperation(operationIdFor(params, params.requestId)))?.environmentId;
      if (!environmentId)
        throw new Error("stale-reference: resource scan requires an existing environment");
      const observed = await store.readEnvironment(environmentId);
      if (!observed) throw new Error("stale-reference: resource scan environment no longer exists");
      assertEnvironmentScope(observed, params);
      const summary = runtimeEnvironmentResourceSummarySchema.parse(
        await resources.scan(environmentId, budget),
      );
      return store.lock(environmentId, async () => {
        const record = await store.readEnvironment(environmentId);
        if (!record) throw new Error("stale-reference: resource scan environment no longer exists");
        assertEnvironmentScope(record, params);
        // 扫描 IO 不占环境短锁；锁内 CAS 防止 release/upgrade 后的迟到摘要覆盖新事实。
        if (
          record.stateRevision !== observed.stateRevision ||
          record.currentRevision !== observed.currentRevision ||
          record.status !== observed.status ||
          record.updatedAt !== observed.updatedAt
        ) {
          throw new Error("stale-reference: environment changed during resource scanning");
        }
        // store 是 stateRevision 唯一写者；必须持环境短锁并读回，不能根据调用前的 revision 猜新值。
        await store.saveEnvironment({ ...record, resourceSummary: summary, updatedAt: stamp() });
        const saved = await store.readEnvironment(environmentId);
        if (saved?.stateRevision === undefined || !saved.resourceSummary)
          throw new Error("stale-reference: resource summary persistence was not confirmed");
        return {
          environmentId,
          stateRevision: saved.stateRevision,
          summary: saved.resourceSummary,
        };
      });
    },
    async garbageCollect(input) {
      const params = runtimeEnvironmentGarbageCollectionParamsSchema.parse(input);
      const result = await resources.collect({
        operationId: scopeKeyHash(["resource-gc", identityKeyOf(params), params.requestId]),
        budget: normalizeResourceScanBudget(params.budget),
        // 删除必须是显式意图；省略 dryRun 只预览，同 requestId 改意图由 adapter journal 拒绝。
        dryRun: params.dryRun !== false,
      });
      const { candidates: _, ...wire } = result;
      return runtimeEnvironmentGarbageCollectionResultSchema.parse(wire);
    },
  };
}
