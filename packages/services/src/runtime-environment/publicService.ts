import { resolve } from "node:path";
import {
  runtimeEnvironmentCapabilitiesSchema,
  runtimeEnvironmentEventSchema,
  runtimeEnvironmentGarbageCollectionParamsSchema,
  runtimeEnvironmentGarbageCollectionResultSchema,
  runtimeEnvironmentGetParamsSchema,
  runtimeEnvironmentListParamsSchema,
  runtimeEnvironmentPrepareParamsSchema,
  runtimeEnvironmentProjectionSchema,
  runtimeEnvironmentReconcileParamsSchema,
  runtimeEnvironmentReconcileResultSchema,
  runtimeEnvironmentReleaseParamsSchema,
  runtimeEnvironmentReleaseResultSchema,
  runtimeEnvironmentResourceScanParamsSchema,
  runtimeEnvironmentResourceScanResultSchema,
  runtimeEnvironmentScopeSchema,
  runtimeEnvironmentServiceActionParamsSchema,
  runtimeEnvironmentServiceActionResultSchema,
  runtimeEnvironmentSnapshotParamsSchema,
  runtimeEnvironmentSnapshotSchema,
  runtimePreparationOperationSchema,
  type RuntimeEnvironmentProjection,
  type RuntimeEnvironmentScope,
  type RuntimePreparationOperation,
  type WorktreeExecutionBinding as WorktreeBinding,
} from "@lcode/shared";
import type { IWorktreeService } from "../worktree/contract.js";
import type { IRuntimeEnvironmentService, RuntimeEnvironmentPrepareRequest } from "./contract.js";
import { safeEnvironmentError } from "./app/manifest.js";

export interface PublicRuntimeEnvironmentServiceOptions {
  worktrees?: Pick<IWorktreeService, "list">;
  attachmentScope?: RuntimeEnvironmentScope;
  /** 仅实际 owner 的组合根转换 storage scope；远端 relay 仍保留调用方 identity。 */
  mapBindingScope?: boolean;
  /** 准备/升级须由既有 worktree owner 完成 binding/session CAS，不能只更新 raw 环境。 */
  prepareOverride?: (
    params: RuntimeEnvironmentPrepareRequest,
    authorizedBinding: WorktreeBinding,
  ) => Promise<RuntimePreparationOperation>;
}

function sameScope(left: RuntimeEnvironmentScope, right: RuntimeEnvironmentScope): boolean {
  const path = (value: string) =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  return (
    (left.workspaceIdentity?.trim() || "") === (right.workspaceIdentity?.trim() || "") &&
    path(left.workspacePath) === path(right.workspacePath)
  );
}
function belongs(scope: RuntimeEnvironmentScope, binding: WorktreeBinding): boolean {
  return (
    sameScope(scope, binding) ||
    sameScope(scope, {
      workspacePath: binding.originalWorkspacePath,
      workspaceIdentity: binding.originalWorkspaceIdentity,
    })
  );
}
function storageScope(binding: WorktreeBinding): RuntimeEnvironmentScope {
  return { workspacePath: binding.checkoutPath };
}
function withScope<T extends RuntimeEnvironmentScope>(
  params: T,
  scope: RuntimeEnvironmentScope,
): T {
  const { workspaceIdentity: _identity, ...rest } = params;
  return { ...rest, ...scope } as T;
}

// 原因：类型窄化不会缩减 ProxyChannel 的运行时方法面；内部 plan/detail/lease 也不能借合法外壳透出。
const privateFields = new Set([
  "env",
  "envOverlay",
  "resourceLeaseToken",
  "lease",
  "ownerId",
  "ownerGeneration",
  "token",
  "plan",
  "commitManifest",
  "requestFingerprint",
  "detail",
  "pid",
]);
function publicValue(value: unknown, field = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => publicValue(item, field));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !privateFields.has(key))
        .map(([key, item]) => [key, publicValue(item, key)]),
    );
  if (typeof value !== "string") return value;
  if (
    ["message", "error", "reason", "stderrTail", "command", "label", "missingReason"].includes(
      field,
    )
  )
    return safeEnvironmentError(value);
  if (field === "urls") {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Invalid runtime service URL");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  return value;
}

/** 无业务缓存/第二 owner：只有公开方法白名单与 attachment 授权，事实始终查询目标环境 owner。 */
export function createPublicRuntimeEnvironmentService(
  service: IRuntimeEnvironmentService,
  options: PublicRuntimeEnvironmentServiceOptions = {},
): IRuntimeEnvironmentService {
  // 这是有界授权集合，不保存 projection/revision/operation；重连必须重新 snapshot。
  const authorizedIds = new Set<string>();
  const remember = (id: string) => {
    if (authorizedIds.size >= 512) authorizedIds.delete(authorizedIds.values().next().value!);
    authorizedIds.add(id);
  };
  async function bindings(scope: RuntimeEnvironmentScope): Promise<WorktreeBinding[]> {
    const attached = options.attachmentScope;
    if (!options.worktrees) {
      if (attached && !sameScope(attached, scope))
        throw new Error("scope-mismatch: runtime attachment differs");
      if (options.mapBindingScope)
        throw new Error("capability-unavailable: runtime binding authorization is unavailable");
      return [];
    }
    const lookupScope = attached ?? scope;
    // 原因：类型窄化不裁剪运行时对象，环境 ID/动作等字段会被工作树 list 的严格合同拒绝。
    // 查询只传工作区路径与身份；后续绑定和环境引用仍按完整原请求授权。
    const listParams: RuntimeEnvironmentScope = {
      workspacePath: lookupScope.workspacePath,
      ...(lookupScope.workspaceIdentity
        ? { workspaceIdentity: lookupScope.workspaceIdentity }
        : {}),
    };
    const candidates = (await options.worktrees.list(listParams)).filter(
      (binding) => binding.status !== "deleted" && belongs(attached ?? scope, binding),
    );
    if (
      attached &&
      !sameScope(attached, scope) &&
      !candidates.some((binding) => belongs(scope, binding))
    )
      throw new Error("scope-mismatch: runtime attachment does not own the workspace");
    return candidates.filter((binding) => belongs(scope, binding));
  }
  async function authorize<T extends RuntimeEnvironmentScope>(params: T): Promise<T> {
    const scope = runtimeEnvironmentScopeSchema.parse({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    if (options.attachmentScope) await bindings(scope);
    return params;
  }
  async function bound<
    T extends RuntimeEnvironmentScope & { environmentId?: string; bindingId?: string },
  >(params: T): Promise<T> {
    await authorize(params);
    if (!options.mapBindingScope) return params;
    const binding = (await bindings(params)).find(
      (item) =>
        (params.bindingId ? item.id === params.bindingId : true) &&
        (params.environmentId ? item.environmentRef?.environmentId === params.environmentId : true),
    );
    if (!binding || (!params.environmentId && !params.bindingId))
      throw new Error("scope-mismatch: runtime environment binding not found");
    if (params.environmentId && binding.environmentRef?.environmentId !== params.environmentId)
      throw new Error("scope-mismatch: runtime environment reference differs");
    return withScope(params, storageScope(binding));
  }
  function projection(value: unknown, expectedId?: string): RuntimeEnvironmentProjection | null {
    if (value === null) return null;
    const result = runtimeEnvironmentProjectionSchema.parse(publicValue(value));
    if (expectedId && result.environmentId !== expectedId)
      throw new Error("scope-mismatch: runtime result environment differs");
    remember(result.environmentId);
    return result;
  }
  async function requestScopes(params: RuntimeEnvironmentScope) {
    await authorize(params);
    if (!options.mapBindingScope) return [{ scope: params, environmentId: undefined }];
    return (await bindings(params)).flatMap((binding) =>
      binding.environmentRef
        ? [{ scope: storageScope(binding), environmentId: binding.environmentRef.environmentId }]
        : [],
    );
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // 严格解析失败不把 owner 的原始结构或秘密字段回显给 UI。
      if (error instanceof Error && error.name === "ZodError")
        throw new Error("Invalid runtime environment public contract");
      throw new Error(safeEnvironmentError(error));
    }
  }
  const facade: IRuntimeEnvironmentService = {
    getCapabilities: (raw) =>
      run(async () => {
        const params = await authorize(runtimeEnvironmentScopeSchema.parse(raw));
        return runtimeEnvironmentCapabilitiesSchema.parse(
          publicValue(await service.getCapabilities(params)),
        );
      }),
    prepare: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentPrepareParamsSchema.parse(raw);
        if (!params.bindingId)
          throw new Error("scope-mismatch: runtime prepare requires an authorized binding");
        await bound(params);
        if (!options.mapBindingScope)
          return runtimePreparationOperationSchema.parse(
            publicValue(await service.prepare(params)),
          );
        const binding = (await bindings(params)).find((item) => item.id === params.bindingId);
        if (!binding) throw new Error("scope-mismatch: runtime prepare binding not found");
        if (!options.prepareOverride)
          throw new Error(
            "capability-unavailable: runtime preparation requires the worktree lifecycle owner",
          );
        return runtimePreparationOperationSchema.parse(
          publicValue(await options.prepareOverride(params, binding)),
        );
      }),
    get: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentGetParamsSchema.parse(raw);
        if (params.environmentId)
          return projection(await service.get(await bound(params)), params.environmentId);
        for (const target of await requestScopes(params)) {
          const result = projection(
            await service.get(withScope(params, target.scope)),
            target.environmentId,
          );
          if (result) return result;
        }
        return null;
      }),
    list: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentListParamsSchema.parse(raw);
        if (!options.mapBindingScope)
          return (await service.list(await authorize(params))).map((item) => projection(item)!);
        const result: RuntimeEnvironmentProjection[] = [];
        for (const target of await requestScopes(params)) {
          const item = projection(
            await service.get({ ...target.scope, environmentId: target.environmentId }),
            target.environmentId,
          );
          if (item && !result.some((known) => known.environmentId === item.environmentId))
            result.push(item);
        }
        return result;
      }),
    snapshot: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentSnapshotParamsSchema.parse(raw);
        const target = await bound(params);
        const result = runtimeEnvironmentSnapshotSchema.parse(
          publicValue(await service.snapshot(target)),
        );
        if (!sameScope(result.scope, target))
          throw new Error("scope-mismatch: runtime snapshot scope differs");
        if (result.environment) {
          projection(result.environment, params.environmentId);
          if (
            result.environment.stateRevision === undefined ||
            result.stateRevision < result.environment.stateRevision
          )
            throw new Error("Invalid runtime snapshot stateRevision watermark");
        }
        remember(params.environmentId);
        return {
          ...result,
          scope: runtimeEnvironmentScopeSchema.parse({
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          }),
        };
      }),
    reconcile: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentReconcileParamsSchema.parse(raw);
        for (const target of await requestScopes(params)) {
          const result = runtimeEnvironmentReconcileResultSchema.parse(
            publicValue(await service.reconcile(withScope(params, target.scope))),
          );
          if (
            result.operation &&
            target.environmentId &&
            result.operation.environmentId !== target.environmentId
          )
            throw new Error("scope-mismatch: runtime operation environment differs");
          projection(result.environment, target.environmentId);
          if (result.operation || result.environment) return result;
        }
        return { operation: null, environment: null };
      }),
    startService: (raw) =>
      run(async () =>
        runtimeEnvironmentServiceActionResultSchema.parse(
          publicValue(
            await service.startService(
              await bound(runtimeEnvironmentServiceActionParamsSchema.parse(raw)),
            ),
          ),
        ),
      ),
    stopService: (raw) =>
      run(async () =>
        runtimeEnvironmentServiceActionResultSchema.parse(
          publicValue(
            await service.stopService(
              await bound(runtimeEnvironmentServiceActionParamsSchema.parse(raw)),
            ),
          ),
        ),
      ),
    resourceSummary: (raw) =>
      run(async () => {
        const params = runtimeEnvironmentResourceScanParamsSchema.parse(raw);
        if (!options.mapBindingScope || params.environmentId)
          return runtimeEnvironmentResourceScanResultSchema.parse(
            publicValue(await service.resourceSummary(await bound(params))),
          );
        // requestId 查询沿原操作所属 binding；不能拿裸 cwd 扫描其它环境。
        for (const target of await requestScopes(params)) {
          const environment = projection(
            await service.get({ ...target.scope, requestId: params.requestId }),
            target.environmentId,
          );
          if (environment)
            return runtimeEnvironmentResourceScanResultSchema.parse(
              publicValue(
                await service.resourceSummary({
                  ...withScope(params, target.scope),
                  environmentId: environment.environmentId,
                }),
              ),
            );
        }
        throw new Error("stale-reference: runtime resource request has no authorized environment");
      }),
    garbageCollect: (raw) =>
      run(async () => {
        const params = await authorize(runtimeEnvironmentGarbageCollectionParamsSchema.parse(raw));
        if (options.mapBindingScope && !(await bindings(params)).length)
          throw new Error(
            "scope-mismatch: runtime garbage collection requires an authorized workspace binding",
          );
        return runtimeEnvironmentGarbageCollectionResultSchema.parse(
          publicValue(await service.garbageCollect(params)),
        );
      }),
    release: (raw) =>
      run(async () =>
        runtimeEnvironmentReleaseResultSchema.parse(
          publicValue(
            await service.release(await bound(runtimeEnvironmentReleaseParamsSchema.parse(raw))),
          ),
        ),
      ),
  };
  if (service.onDidChangeEnvironment) {
    Object.defineProperty(facade, "onDidChangeEnvironment", {
      enumerable: true,
      value: ((listener) =>
        service.onDidChangeEnvironment!((event) => {
          if (!authorizedIds.has(event.environmentId)) return;
          // 只发送 invalidation；不能把 live service event 冒充持久 event replay。
          const safe = runtimeEnvironmentEventSchema.safeParse({
            environmentId: event.environmentId,
            stateRevision: event.stateRevision,
            kind: event.kind,
          });
          if (safe.success) listener(safe.data);
        })) satisfies NonNullable<IRuntimeEnvironmentService["onDidChangeEnvironment"]>,
    });
  }
  return facade;
}
