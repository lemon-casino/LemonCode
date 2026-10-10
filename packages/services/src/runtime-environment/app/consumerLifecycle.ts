import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  runtimeConsumerAcquireParamsSchema,
  runtimeConsumerReferenceSchema,
  runtimeConsumerReleaseParamsSchema,
  runtimeConsumerSessionDeletionParamsSchema,
  runtimeEnvironmentReleaseParamsSchema,
  type RuntimeConsumerReference,
  type RuntimeConsumerReleaseResult,
  type RuntimeEnvironmentError,
  type RuntimeEnvironmentRecord,
  type RuntimeEnvironmentScope,
} from "@lcode/shared";
import type {
  RuntimeEnvironmentConsumerAuthority,
  RuntimeEnvironmentReleaseRequest,
  RuntimeProcessOwnerObserver,
} from "../contract.js";
import { advanceStatus } from "../domain/state.js";
import { hasServiceExitProof } from "../domain/services.js";
import { migrateEnvironmentSessions } from "./consumerMigration.js";
import { retireLegacyProcessesForDeletion } from "./legacyConsumerRetirement.js";
import {
  confirmStoredProcessExit,
  retainProcessOwnerReceipt,
  settleConfirmedProcessExits,
} from "./consumerOwnerReceipts.js";
import { identityKeyOf, type RuntimeEnvironmentStore } from "./ports.js";

function reject(code: RuntimeEnvironmentError["code"], message: string): never {
  // 授权错误只含稳定原因，不把内部 lease 或完整消费者记录交给调用方。
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function assertScope(record: RuntimeEnvironmentRecord, scope: RuntimeEnvironmentScope): void {
  if (
    identityKeyOf(record.scope) !== identityKeyOf(scope) ||
    canonicalPath(record.scope.workspacePath) !== canonicalPath(scope.workspacePath)
  ) {
    reject("scope-mismatch", "consumer scope does not match its environment");
  }
}

function activeCount(refs: RuntimeConsumerReference[]): number {
  return refs.filter((ref) => ref.state === "active").length;
}

/** 仅在持有环境锁时调用；保留墓碑，迟到登记不能把已释放的同名引用复活。 */
async function releaseMatching(
  store: RuntimeEnvironmentStore,
  environmentId: string,
  refs: RuntimeConsumerReference[],
  matches: (ref: RuntimeConsumerReference) => boolean,
  stamp: () => string,
): Promise<RuntimeConsumerReleaseResult> {
  let removed = 0;
  const next = refs.map((ref) => {
    if (ref.state !== "active" || !matches(ref)) return ref;
    removed++;
    return { ...ref, state: "released" as const, updatedAt: stamp() };
  });
  if (removed > 0) await store.saveConsumers(environmentId, next);
  return { removed, remaining: activeCount(next) };
}

/**
 * spec §13：消费者事实只有一个 owner；两 Host 使用同一环境 ID 短锁与持久记录。
 * 登记/精确释放/已确认删除 → 环境锁 → 重读 scope/revision → 引用或墓碑。
 * 本 authority 仅供 Host 内部组合使用；lease 不进入上下文查询与 UI 投影。
 */
export function createRuntimeConsumerAuthority(
  store: RuntimeEnvironmentStore,
  stamp: () => string,
  observeProcessOwner?: RuntimeProcessOwnerObserver,
): RuntimeEnvironmentConsumerAuthority {
  return {
    migrateSessions: (params) => migrateEnvironmentSessions(store, params, stamp),
    retireLegacyProcessesForDeletion: (params) =>
      retireLegacyProcessesForDeletion(store, params, stamp, observeProcessOwner),
    async acquire(input, processOwner) {
      const params = runtimeConsumerAcquireParamsSchema.parse(input);
      return store.lock(params.environmentId, async () => {
        const record = await store.readEnvironment(params.environmentId);
        if (!record) reject("stale-reference", "environment does not exist");
        assertScope(record, params);
        if (record.status !== "ready") reject("resource-busy", "environment is not ready");
        if (params.revision !== record.currentRevision) {
          reject("stale-reference", "environment revision does not match");
        }
        if (params.manifestDigest !== undefined && params.manifestDigest !== record.manifestDigest)
          reject("stale-reference", "environment manifest does not match");
        if (
          params.kind === "session" &&
          (!record.bindingId || params.ownerId !== `binding:${record.bindingId}`)
        ) {
          reject("scope-mismatch", "session owner does not match its binding");
        }
        const refs = await store.listConsumers(params.environmentId);
        const index = refs.findIndex((ref) => ref.kind === params.kind && ref.id === params.id);
        const previous = refs[index];
        if (previous?.state === "active") {
          if (previous.ownerId !== params.ownerId) {
            reject("resource-busy", "active consumer belongs to another owner");
          }
          if (previous.revision !== params.revision) {
            reject("stale-reference", "active consumer revision does not match");
          }
          if (processOwner) await retainProcessOwnerReceipt(store, previous, processOwner);
          return previous;
        }
        const generation = previous?.ownerGeneration ?? 0;
        if (
          previous
            ? params.expectedOwnerGeneration !== generation
            : params.expectedOwnerGeneration !== undefined && params.expectedOwnerGeneration !== 0
        ) {
          reject("stale-reference", "consumer registration requires the previous owner generation");
        }
        const at = stamp();
        const reference = runtimeConsumerReferenceSchema.parse({
          environmentId: params.environmentId,
          kind: params.kind,
          id: params.id,
          revision: params.revision,
          ownerId: params.ownerId,
          ownerGeneration: generation + 1,
          lease: randomUUID(),
          state: "active",
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
        });
        if (processOwner) await retainProcessOwnerReceipt(store, reference, processOwner);
        if (index < 0) refs.push(reference);
        else refs[index] = reference;
        await store.saveConsumers(params.environmentId, refs);
        return reference;
      });
    },

    async confirmProcessExit(input, owner) {
      const params = runtimeConsumerReleaseParamsSchema.parse(input);
      await store.lock(params.environmentId, async () => {
        const record = await store.readEnvironment(params.environmentId);
        if (!record) return;
        assertScope(record, params);
        await confirmStoredProcessExit(store, params, owner, stamp);
      });
    },

    async release(input) {
      const params = runtimeConsumerReleaseParamsSchema.parse(input);
      return store.lock(params.environmentId, async () => {
        const record = await store.readEnvironment(params.environmentId);
        if (!record) return { removed: 0, remaining: 0 };
        assertScope(record, params);
        const refs = await store.listConsumers(params.environmentId);
        return releaseMatching(
          store,
          params.environmentId,
          refs,
          (ref) =>
            ref.environmentId === params.environmentId &&
            ref.kind === params.kind &&
            ref.id === params.id &&
            ref.ownerId === params.ownerId &&
            ref.ownerGeneration === params.ownerGeneration &&
            ref.lease === params.lease,
          stamp,
        );
      });
    },

    async releaseSessionsAfterDeletion(input) {
      const params = runtimeConsumerSessionDeletionParamsSchema.parse(input);
      return store.lock(params.environmentId, async () => {
        const record = await store.readEnvironment(params.environmentId);
        if (!record) return { removed: 0, remaining: 0 };
        assertScope(record, params);
        if (record.bindingId !== params.bindingId) {
          reject("scope-mismatch", "deleted sessions do not match the environment binding");
        }
        // 这是持久删除成功后的受信组合回调；app.close/归档/断线不能调用它。
        const ids = new Set(params.sessionIds);
        const refs = await store.listConsumers(params.environmentId);
        return releaseMatching(
          store,
          params.environmentId,
          refs,
          (ref) =>
            ref.environmentId === params.environmentId &&
            ref.kind === "session" &&
            ref.ownerId === `binding:${params.bindingId}` &&
            ids.has(ref.id),
          stamp,
        );
      });
    },
  };
}

const pendingPreparation = new Set<RuntimeEnvironmentRecord["status"]>([
  "allocated",
  "resolvingTools",
  "installingTools",
  "preparingDependencies",
  "cancelling",
]);

/** spec §13：同一环境锁内写 fence，再读取活引用/停止证明；不按 PID 停进程或删文件。 */
export async function releaseRuntimeEnvironment(
  store: RuntimeEnvironmentStore,
  input: RuntimeEnvironmentReleaseRequest,
  stamp: () => string,
): Promise<{ status: "released" | "releaseBlocked"; reason?: string }> {
  const params = runtimeEnvironmentReleaseParamsSchema.parse(input);
  return store.lock(params.environmentId, async () => {
    const record = await store.readEnvironment(params.environmentId);
    if (!record) return { status: "released" };
    assertScope(record, params);
    // 必须在同一锁内重读后检查；锁前 revision 检查会误释放已经升级的环境。
    if (
      params.expectedRevision !== undefined &&
      params.expectedRevision !== record.currentRevision
    ) {
      return {
        status: "releaseBlocked",
        reason: "stale-reference: environment revision does not match",
      };
    }
    if (
      params.expectedManifestDigest !== undefined &&
      params.expectedManifestDigest !== record.manifestDigest
    )
      return {
        status: "releaseBlocked",
        reason: "stale-reference: environment manifest does not match",
      };
    if (record.status === "released") return { status: "released" };
    const transition = advanceStatus(record.status, "release");
    if (pendingPreparation.has(record.status) || transition.invalid) {
      // 准备/取消尚未结算：保留执行中的状态，不能伪造 fence 后让重试跳过真实 writer。
      return { status: "releaseBlocked", reason: "release-blocked: preparation is not settled" };
    }
    const fenced: RuntimeEnvironmentRecord = {
      ...record,
      status: "releasing",
      error: undefined,
      updatedAt: stamp(),
    };
    await store.saveEnvironment(fenced);
    const consumers = activeCount(
      await settleConfirmedProcessExits(store, params.environmentId, stamp),
    );
    let services = 0;
    for (const serviceId of await store.listServiceIds(params.environmentId)) {
      const receipt = await store.readServiceReceipt(params.environmentId, serviceId);
      // failed 不代表进程已退出；缺失/unknown 收据也不能作为停止证明（spec §12.1）。
      if (!receipt || !hasServiceExitProof(receipt)) {
        services++;
      }
    }
    if (consumers > 0 || services > 0) {
      const reason = `release-blocked: ${consumers} active consumers, ${services} unconfirmed services`;
      await store.saveEnvironment({
        ...fenced,
        status: "releaseBlocked",
        updatedAt: stamp(),
        error: {
          code: "release-blocked",
          stage: "releasing",
          retryable: true,
          message: reason,
          detail: { activeConsumers: String(consumers), unconfirmedServices: String(services) },
        },
      });
      return { status: "releaseBlocked", reason };
    }
    // released 只结算逻辑引用；目录、私有数据和工具缓存的物理回收仍需删除事务另行确认。
    await store.saveEnvironment({ ...fenced, status: "released", updatedAt: stamp() });
    return { status: "released" };
  });
}
