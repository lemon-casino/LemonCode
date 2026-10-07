import type { ManagedServiceReceipt, RuntimeEnvironmentRecord } from "@lcode/shared";
import type { ServiceDefinition } from "../domain/services.js";
import {
  hasServiceExitProof,
  nextGenerationAfter,
  reconcileStartIntent,
  serviceUrlOrigin,
} from "../domain/services.js";
import type { ServiceProcessPort } from "./ports.js";
import {
  changedEnvironment,
  defaultProbe,
  failure,
  markUnknown,
  owned,
  recordExit,
  registerOwner,
  retireOwner,
  safeFailure,
  sameGeneration,
  saveServiceFact as save,
  type ServiceStageContext,
  type ServiceStageResult,
  type ServiceIntent as Intent,
  type ServiceOwner as Owner,
} from "./serviceStageOwner.js";
export type { ServiceStageContext, ServiceStageResult } from "./serviceStageOwner.js";

export async function startManagedService(
  context: ServiceStageContext,
  record: RuntimeEnvironmentRecord,
  definition: ServiceDefinition,
  intent: Intent = {},
): Promise<ServiceStageResult> {
  const { store, processes } = context;
  const admission = await store.lock(
    record.environmentId,
    async (): Promise<
      | ServiceStageResult
      | {
          receipt: ManagedServiceReceipt;
          owner: Owner;
        }
    > => {
      const environment = await store.readEnvironment(record.environmentId);
      const changed = changedEnvironment(environment, record);
      if (changed) return changed;
      if (environment!.status !== "ready")
        return { status: "blocked", reason: "resource-busy: environment is fenced or not ready" };
      const previous = await store.readServiceReceipt(record.environmentId, definition.serviceId);
      const decision = reconcileStartIntent({
        existing: previous,
        requestedRevision: record.currentRevision,
        expectedGeneration: intent.expectedGeneration,
      });
      if (decision.action === "needsRestart")
        return { status: "needsRestart", receipt: previous ?? undefined };
      if (previous && !hasServiceExitProof(previous) && !owned(context, previous))
        return markUnknown(previous);
      if (intent.onlyOwnedGeneration && (!previous || hasServiceExitProof(previous)))
        return { status: "notRunning", receipt: previous ?? undefined };
      if (previous && intent.operationId && previous.operationId === intent.operationId)
        return { status: "reused", receipt: previous };
      if (decision.action === "reuse") return { status: "reused", receipt: previous! };
      if (decision.action === "blocked")
        return {
          status: "blocked",
          receipt: previous!,
          reason: "process-unknown: previous generation has no exit proof",
        };
      if (!processes?.onExit)
        return {
          status: "blocked",
          reason: "capability-unavailable: process owner with exit observation is required",
        };
      if (definition.writesSource)
        return {
          status: "blocked",
          reason: "resource-busy: source-writing services require a checkout writer permit",
        };
      for (const serviceId of definition.dependsOn ?? []) {
        const dependency = await store.readServiceReceipt(record.environmentId, serviceId);
        if (
          !dependency ||
          dependency.state !== "running" ||
          dependency.revision !== record.currentRevision ||
          !owned(context, dependency)
        )
          return {
            status: "blocked",
            reason: "resource-busy: a service dependency is not running under this owner",
          };
      }
      const receipt = await save(context, {
        environmentId: record.environmentId,
        revision: record.currentRevision,
        serviceId: definition.serviceId,
        generation: nextGenerationAfter(previous),
        state: "starting",
        urls: [],
        startedAt: context.stamp(),
        operationId: intent.operationId,
      });
      const owner: Owner = {
        abort: new AbortController(),
        launch: Promise.withResolvers<void>(),
        attempted: false,
      };
      registerOwner(processes, receipt, owner);
      try {
        // route 与 starting 同一 admission 锁发布，peer 不能看到尚无 owner route 的半登记。
        await context.ownerChannel?.publish(receipt);
      } catch {
        owner.exit = {};
        owner.launch.resolve();
        const blocked = await save(context, {
          ...receipt,
          state: "failed",
          stoppedAt: context.stamp(),
          error: "process-unknown: service owner route could not be published",
        });
        return { status: "blocked", receipt: blocked, reason: blocked.error };
      }
      return { receipt, owner };
    },
  );
  if ("status" in admission) return admission;
  const { receipt, owner } = admission;
  try {
    if (context.acquireLease) {
      try {
        owner.lease = await context.acquireLease({
          resourceKey: `service-port:${record.environmentId}:${definition.serviceId}`,
          ownerId: `service:${record.environmentId}:${definition.serviceId}:${receipt.generation}`,
        });
      } catch {
        throw failure("resource-busy");
      }
    }
    if (owner.abort.signal.aborted) throw failure("cancelled");
    await context.beforeStart?.(record, definition, owner.abort.signal);
    const launch = context.prepareLaunch
      ? await context.prepareLaunch(record, definition)
      : definition;
    const permitted = await store.lock(record.environmentId, async () => {
      const current = await store.readServiceReceipt(record.environmentId, definition.serviceId);
      const environment = await store.readEnvironment(record.environmentId);
      return (
        sameGeneration(current, receipt) &&
        current.state === "starting" &&
        environment?.status === "ready" &&
        !changedEnvironment(environment, record) &&
        !owner.abort.signal.aborted
      );
    });
    if (!permitted) throw failure("cancelled");
    processes!.onExit!(receipt, (code) => recordExit(context, receipt, owner, code));
    owner.attempted = true;
    let handle: Awaited<ReturnType<ServiceProcessPort["start"]>>;
    try {
      handle = await processes!.start({
        environmentId: receipt.environmentId,
        serviceId: receipt.serviceId,
        generation: receipt.generation,
        argv: launch.argv,
        cwd: launch.cwd,
        env: launch.env,
        ports: launch.ports,
        signal: owner.abort.signal,
      });
    } finally {
      owner.launch.resolve();
    }
    const urls = handle.urls.map(serviceUrlOrigin);
    // 根因：原条件只拒绝“全部失败”，空地址或部分失败也会虚报 running。
    if (
      !urls.length ||
      urls.length > 16 ||
      urls.some((url) => !url) ||
      owner.exit ||
      owner.abort.signal.aborted
    )
      throw failure("unhealthy");
    const verified = urls as string[];
    if (
      !(await Promise.all(verified.map((url) => (context.probe ?? defaultProbe)(url)))).every(
        Boolean,
      )
    )
      throw failure("unhealthy");
    const running = await store.lock(record.environmentId, async () => {
      const current = await store.readServiceReceipt(record.environmentId, definition.serviceId);
      const environment = await store.readEnvironment(record.environmentId);
      if (
        !sameGeneration(current, receipt) ||
        current.state !== "starting" ||
        owner.exit ||
        owner.abort.signal.aborted ||
        environment?.status !== "ready" ||
        changedEnvironment(environment, record)
      )
        return undefined;
      return save(context, {
        ...current,
        state: "running",
        urls: verified,
        pid: handle.pid,
        healthCheckedAt: context.stamp(),
      });
    });
    if (!running) throw failure("cancelled");
    return { status: "started", receipt: running };
  } catch (error) {
    owner.failure = safeFailure(error);
    owner.launch.resolve();
    // start 抛错不能推断没有残留 child；只接受 owner.stop 或已收到的真实 close 证明。
    let proof = owner.exit ?? (!owner.attempted ? {} : undefined);
    if (!proof) {
      try {
        proof = await processes!.stop(receipt);
      } catch {
        /* 无退出证明，保留资源和阻塞态。 */
      }
      proof ??= owner.exit;
    }
    if (proof) owner.exit = proof;
    const failed = await store.lock(record.environmentId, async () => {
      const current = await store.readServiceReceipt(record.environmentId, definition.serviceId);
      if (!sameGeneration(current, receipt)) return undefined;
      return save(context, {
        ...current,
        state: "failed",
        urls: [],
        healthCheckedAt: undefined,
        stoppedAt: proof ? (current.stoppedAt ?? context.stamp()) : undefined,
        exitCode: proof?.exitCode,
        error: owner.failure,
      });
    });
    if (proof) await retireOwner(context, receipt, owner);
    return { status: "failed", receipt: failed, reason: owner.failure };
  }
}

export async function stopManagedService(
  context: ServiceStageContext,
  record: RuntimeEnvironmentRecord,
  serviceId: string,
  intent: Intent = {},
): Promise<ServiceStageResult> {
  const { store } = context;
  const admission = await store.lock(
    record.environmentId,
    async (): Promise<
      | ServiceStageResult
      | {
          receipt: ManagedServiceReceipt;
          owner: Owner;
        }
    > => {
      const environment = await store.readEnvironment(record.environmentId);
      const changed = changedEnvironment(environment, record);
      if (changed) return changed;
      const receipt = await store.readServiceReceipt(record.environmentId, serviceId);
      if (
        intent.expectedGeneration !== undefined &&
        receipt?.generation !== intent.expectedGeneration
      )
        return {
          status: "needsRestart",
          receipt: receipt ?? undefined,
          reason: "stale-reference: service generation changed",
        };
      if (!receipt || hasServiceExitProof(receipt))
        return { status: "notRunning", receipt: receipt ?? undefined };
      const owner = owned(context, receipt);
      if (!owner) return markUnknown(receipt);
      owner.abort.abort();
      const stopping =
        receipt.state === "stopping"
          ? receipt
          : await save(context, {
              ...receipt,
              state: "stopping",
              urls: [],
              healthCheckedAt: undefined,
            });
      return { receipt: stopping, owner };
    },
  );
  if ("status" in admission) return admission;
  const { receipt, owner } = admission;
  owner.stop ??= (async (): Promise<ServiceStageResult> => {
    await owner.launch.promise;
    let proof = owner.exit ?? (!owner.attempted ? {} : undefined);
    if (!proof) {
      try {
        proof = await context.processes!.stop(receipt);
      } catch {
        /* owner 未确认退出，不冒充 stopped。 */
      }
      proof ??= owner.exit;
    }
    if (proof) owner.exit = proof;
    const result = await store.lock(record.environmentId, async (): Promise<ServiceStageResult> => {
      const current = await store.readServiceReceipt(record.environmentId, serviceId);
      if (!sameGeneration(current, receipt))
        return { status: "needsRestart", receipt: current ?? undefined };
      if (hasServiceExitProof(current)) return { status: "stopped", receipt: current };
      const next = await save(context, {
        ...current,
        state: proof ? "stopped" : "failed",
        urls: [],
        healthCheckedAt: undefined,
        stoppedAt: proof ? context.stamp() : undefined,
        exitCode: proof?.exitCode,
        error: proof ? undefined : "process owner did not confirm exit",
      });
      return { status: proof ? "stopped" : "stopFailed", receipt: next, reason: next.error };
    });
    if (proof) await retireOwner(context, receipt, owner);
    return result;
  })().finally(() => {
    owner.stop = undefined;
  });
  return owner.stop;
}
