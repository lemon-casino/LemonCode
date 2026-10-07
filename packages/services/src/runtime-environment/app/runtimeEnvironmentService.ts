import type { Event } from "@lcode/rpc";
import type {
  RuntimeEnvironmentCapabilities,
  RuntimeEnvironmentEvent,
  RuntimeEnvironmentRecord,
} from "@lcode/shared";
import type {
  IRuntimeEnvironmentHostService,
  IRuntimeEnvironmentService,
  RuntimeEnvironmentPrepareRequest,
  RuntimeEnvironmentScopeRef,
} from "../contract.js";
import type { PreparationOptions } from "./preparationTypes.js";
import { preparationError } from "./preparationTypes.js";
import { admitPreparation, assertEnvironmentScope } from "./preparationAdmission.js";
import { runPreparation } from "./preparationPipeline.js";
import { finishPreparationCommit } from "./preparationCommit.js";
import { declarationDigest, hostPlatform, safeEnvironmentError } from "./manifest.js";
import { identityKeyOf, operationIdFor } from "./ports.js";
import { projectEnvironment } from "./projection.js";
import { queryFrozenContext, queryFrozenContextForCwd } from "./frozenContext.js";
import { releaseRuntimeEnvironment } from "./consumerLifecycle.js";

export interface RuntimeEnvironmentServiceOptions extends Omit<
  PreparationOptions,
  "stamp" | "managed" | "appDefaultTools" | "backendVersion"
> {
  now?: () => Date;
  managed?: boolean;
  appDefaultTools?: ReadonlyArray<{ key: string; version: string }>;
  backendVersion?: string;
  services?: Pick<IRuntimeEnvironmentService, "startService" | "stopService">;
  resources?: Pick<IRuntimeEnvironmentService, "resourceSummary" | "garbageCollect">;
  onDidChangeEnvironment?: Event<RuntimeEnvironmentEvent>;
  reconcileReceipt?: (
    record: RuntimeEnvironmentRecord,
    receipt: import("@lcode/shared").ManagedServiceReceipt,
  ) => Promise<import("@lcode/shared").ManagedServiceReceipt>;
  listServices?: (
    record: RuntimeEnvironmentRecord,
  ) => Promise<
    NonNullable<import("@lcode/shared").RuntimeEnvironmentProjection["availableServices"]>
  >;
}
const APP_DEFAULTS = [
  { key: "node", version: "24.14.0" },
  { key: "pnpm", version: "10.33.2" },
] as const;
export function createRuntimeEnvironmentService(
  options: RuntimeEnvironmentServiceOptions,
): IRuntimeEnvironmentHostService & {
  prepareUnderWriter(
    params: RuntimeEnvironmentPrepareRequest,
  ): ReturnType<IRuntimeEnvironmentHostService["prepare"]>;
  disposeAndWait(): Promise<void>;
} {
  const { store } = options;
  const stamp = () => (options.now?.() ?? new Date()).toISOString();
  const preparation: PreparationOptions = {
    ...options,
    stamp,
    managed: options.managed ?? true,
    appDefaultTools: options.appDefaultTools ?? APP_DEFAULTS,
    backendVersion: options.backendVersion ?? "v2026.10.2",
  };
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  async function executePrepare(params: RuntimeEnvironmentPrepareRequest, underWriter = false) {
    if (disposed) throw new Error("resource-busy: runtime environment owner is shutting down");
    const admitted = await admitPreparation(preparation, params);
    if (params.cancel) controllers.get(admitted.operation.operationId)?.abort();
    if (!admitted.run) return admitted.operation;
    const controller = new AbortController();
    controllers.set(admitted.operation.operationId, controller);
    if (disposed) controller.abort();
    try {
      return await runPreparation(preparation, admitted.run, controller.signal, underWriter);
    } finally {
      controllers.delete(admitted.operation.operationId);
    }
  }
  function prepare(params: RuntimeEnvironmentPrepareRequest, underWriter = false) {
    const promise = executePrepare(params, underWriter);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  }
  async function refresh(record: RuntimeEnvironmentRecord): Promise<RuntimeEnvironmentRecord> {
    if (!["ready", "needsUpdate"].includes(record.status) || record.activeOperationId)
      return record;
    let digest: string | undefined;
    let reason: string | undefined;
    try {
      digest = declarationDigest(await options.declarations.read(record.scope.workspacePath));
    } catch (error) {
      reason = safeEnvironmentError(error);
    }
    return store.lock(record.environmentId, async () => {
      const current = await store.readEnvironment(record.environmentId);
      if (!current) throw new Error("stale-reference: environment disappeared");
      if (
        current.currentRevision !== record.currentRevision ||
        !["ready", "needsUpdate"].includes(current.status)
      )
        return current;
      const manifest = await store.readManifest(current.environmentId, current.currentRevision);
      if (manifest && manifest.declarationDigest === digest && !reason && manifest.manifestDigest)
        return current;
      if (current.status !== "needsUpdate")
        await store.saveEnvironment({
          ...current,
          status: "needsUpdate",
          updatedAt: stamp(),
          error: preparationError(
            "stale-reference",
            "updating",
            reason ?? "project declarations or lock contents changed; update the environment",
          ),
        });
      return (await store.readEnvironment(record.environmentId))!;
    });
  }
  async function readScoped(
    params: RuntimeEnvironmentScopeRef & { environmentId?: string; requestId?: string },
  ) {
    const id =
      params.environmentId ??
      (params.requestId
        ? (await store.readOperation(operationIdFor(params, params.requestId)))?.environmentId
        : undefined);
    const record = id ? await store.readEnvironment(id) : null;
    if (!record) return null;
    assertEnvironmentScope(record, params);
    return refresh(record);
  }
  const project = async (record: RuntimeEnvironmentRecord) => {
    let observed = record;
    for (let attempt = 0; attempt < 3; attempt++) {
      // owner 查询可能跨 Host；锁外取得服务状态，再以环境事实版本确认同一快照，避免互等同一锁。
      const projection = await projectEnvironment(store, observed, options.reconcileReceipt);
      const availableServices =
        options.listServices && observed.status !== "released"
          ? await options.listServices(observed)
          : undefined;
      const current = await store.lock(observed.environmentId, () =>
        store.readEnvironment(observed.environmentId),
      );
      if (!current) throw new Error("stale-reference: environment disappeared during snapshot");
      if (current.stateRevision === observed.stateRevision)
        return { ...projection, ...(availableServices ? { availableServices } : {}) };
      observed = current;
    }
    throw new Error("resource-busy: environment changed while reading its snapshot");
  };
  const unavailable = (feature: string): never => {
    throw new Error(`capability-unavailable: ${feature} is unavailable on this Host`);
  };
  const service: IRuntimeEnvironmentHostService & {
    prepareUnderWriter: typeof prepare;
    disposeAndWait(): Promise<void>;
  } = {
    ...(options.onDidChangeEnvironment
      ? { onDidChangeEnvironment: options.onDidChangeEnvironment }
      : {}),
    async getCapabilities(): Promise<RuntimeEnvironmentCapabilities> {
      const probe = preparation.managed
        ? await options.backend.probeBackend()
        : {
            available: false,
            reason: options.missingReason ?? "managed environments are disabled",
          };
      return {
        managedEnvironments: probe.available,
        protocolVersion: 1,
        platform: hostPlatform(),
        backend: { kind: "mise", version: preparation.backendVersion, available: probe.available },
        actions: probe.available
          ? [
              "prepare",
              "resolveContext",
              "retainSession",
              "releaseConsumer",
              "reconcile",
              ...(options.services ? (["startService", "stopService"] as const) : []),
              ...(options.resources ? (["resourceSummary", "garbageCollect"] as const) : []),
            ]
          : [],
        ...(!probe.available
          ? { missingReason: (probe.reason ?? "bundled mise is unavailable").slice(0, 2048) }
          : {}),
      };
    },
    prepare: (params) => prepare(params),
    prepareUnderWriter: (params) => prepare(params, true),
    async disposeAndWait() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.allSettled(pending);
    },
    async get(params) {
      const record = await readScoped(params);
      return record ? project(record) : null;
    },
    async list(params) {
      const records = (await store.listEnvironments()).filter(
        (record) => identityKeyOf(record.scope) === identityKeyOf(params),
      );
      return Promise.all(records.map(async (record) => project(await refresh(record))));
    },
    async snapshot(params) {
      const record = await readScoped(params);
      if (!record)
        return {
          protocolVersion: 1,
          scope: {
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          },
          stateRevision: 0,
        };
      const environment = await project(record);
      return {
        protocolVersion: 1,
        scope: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        },
        stateRevision: environment.stateRevision ?? 0,
        environment,
      };
    },
    async resolveContext(params) {
      const record = await readScoped(params);
      if (record?.status === "needsUpdate")
        throw new Error(
          "stale-reference: environment requires an explicit update before new execution",
        );
      return queryFrozenContext(store, params);
    },
    resolveContextForCwd: (params) => queryFrozenContextForCwd(store, params),
    release: (params) => releaseRuntimeEnvironment(store, params, stamp),
    async reconcile(params) {
      let operation = await store.readOperation(operationIdFor(params, params.requestId));
      if (operation?.status === "running") {
        const record = await store.readEnvironment(operation.environmentId);
        if (record) {
          assertEnvironmentScope(record, params);
          const release = await store.claimPreparation(record.environmentId);
          if (release) {
            try {
              await store.lock(record.environmentId, async () => {
                const latest = await store.readOperation(operation!.operationId);
                const environment = await store.readEnvironment(record.environmentId);
                if (!latest || latest.status !== "running" || !environment) return;
                if (latest.commitManifest) {
                  operation = await finishPreparationCommit(store, latest, environment, stamp);
                  return;
                }
                if (environment.activeOperationId !== latest.operationId) return;
                operation = {
                  ...latest,
                  status: latest.cancelRequested ? "cancelled" : "failed",
                  updatedAt: stamp(),
                  error: latest.cancelRequested
                    ? undefined
                    : preparationError(
                        "process-unknown",
                        "resolvingTools",
                        "preparation owner exited; explicit retry is required",
                      ),
                };
                await store.saveOperation(operation);
                await store.saveEnvironment({
                  ...environment,
                  activeOperationId: undefined,
                  status: operation.status === "cancelled" ? "cancelled" : "failed",
                  error: operation.error,
                  updatedAt: stamp(),
                });
              });
            } finally {
              await release();
            }
          }
        }
      }
      const record = operation
        ? await readScoped({ ...params, environmentId: operation.environmentId })
        : null;
      return { operation, environment: record ? await project(record) : null };
    },
    startService: (params) => options.services?.startService(params) ?? unavailable("startService"),
    stopService: (params) => options.services?.stopService(params) ?? unavailable("stopService"),
    resourceSummary: (params) =>
      options.resources?.resourceSummary(params) ?? unavailable("resourceSummary"),
    garbageCollect: (params) =>
      options.resources?.garbageCollect(params) ?? unavailable("garbageCollect"),
  };
  return service;
}
