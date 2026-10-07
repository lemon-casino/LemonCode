import { connect } from "node:net";
import { resolve } from "node:path";
import type {
  ManagedServiceReceipt,
  RuntimeEnvironmentRecord,
  RuntimeEnvironmentServiceActionParams,
  RuntimeEnvironmentServiceActionResult,
} from "@lcode/shared";
import type { ServiceDefinition } from "../domain/services.js";
import { hasServiceExitProof, serviceUrlOrigin } from "../domain/services.js";
import { identityKeyOf, type RuntimeEnvironmentStore, type ServiceProcessPort } from "./ports.js";

export interface ServiceOwnerKey {
  environmentId: string;
  serviceId: string;
  generation: number;
}
export type ServiceOwnerAction = "start" | "stop" | "query";
export type ServiceOwnerRequest = RuntimeEnvironmentServiceActionParams & {
  expectedGeneration: number;
};
/** Host 内私有控制面，秘密与路由文件不进入公开合同或 UI。 */
export interface ServiceOwnerChannel {
  publish(key: ServiceOwnerKey): Promise<void>;
  remove(key: ServiceOwnerKey): Promise<void>;
  request(
    action: ServiceOwnerAction,
    params: ServiceOwnerRequest,
  ): Promise<RuntimeEnvironmentServiceActionResult | undefined>;
  disposeAndWait(): Promise<void>;
}

/** spec §12：环境锁只负责 admission/结算；进程 owner 持有句柄，持久 PID 永不授权停止。 */
export interface ServiceStageContext {
  store: RuntimeEnvironmentStore;
  processes?: ServiceProcessPort & { isAlive?(key: ServiceOwnerKey): boolean };
  ownerChannel?: ServiceOwnerChannel;
  beforeStart?: (
    record: RuntimeEnvironmentRecord,
    definition: ServiceDefinition,
    signal: AbortSignal,
  ) => Promise<void>;
  probe?: (url: string) => Promise<boolean>;
  acquireLease?: (params: { resourceKey: string; ownerId: string }) => Promise<{
    token: string;
    release: () => Promise<void>;
  }>;
  prepareLaunch?: (
    record: RuntimeEnvironmentRecord,
    definition: ServiceDefinition,
  ) => Promise<{
    argv: string[];
    cwd: string;
    env?: Record<string, string>;
    ports?: number[];
  }>;
  stamp: () => string;
}
export interface ServiceStageResult {
  status:
    | "started"
    | "reused"
    | "needsRestart"
    | "failed"
    | "blocked"
    | "stopped"
    | "notRunning"
    | "stopFailed";
  receipt?: ManagedServiceReceipt;
  reason?: string;
}
export interface ServiceIntent {
  expectedGeneration?: number;
  operationId?: string;
  /** 来自已认证 peer 的同代复用意图，禁止在旧代退出后偷偷开新代。 */
  onlyOwnedGeneration?: boolean;
}
export interface ServiceOwner {
  abort: AbortController;
  launch: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  exit?: { exitCode?: number };
  failure?: string;
  lease?: { release: () => Promise<void> };
  release?: Promise<void>;
  stop?: Promise<ServiceStageResult>;
}
// 只登记本 Host 的在途副作用身份，不保存第二份服务事实；每服务只保留当前代句柄。
const owners = new WeakMap<
  ServiceProcessPort,
  Map<string, { generation: number; owner: ServiceOwner }>
>();
const keyOf = (receipt: Pick<ManagedServiceReceipt, "environmentId" | "serviceId">) =>
  JSON.stringify([receipt.environmentId, receipt.serviceId]);
export function registerOwner(
  port: ServiceProcessPort,
  receipt: ManagedServiceReceipt,
  owner: ServiceOwner,
): void {
  let map = owners.get(port);
  if (!map) {
    map = new Map();
    owners.set(port, map);
  }
  map.set(keyOf(receipt), { generation: receipt.generation, owner });
}
export function owned(
  context: ServiceStageContext,
  receipt: ServiceOwnerKey,
): ServiceOwner | undefined {
  const found = context.processes ? owners.get(context.processes)?.get(keyOf(receipt)) : undefined;
  return found?.generation === receipt.generation ? found.owner : undefined;
}
export function sameGeneration(
  left: ManagedServiceReceipt | null,
  right: ManagedServiceReceipt,
): left is ManagedServiceReceipt {
  return left?.generation === right.generation && left.revision === right.revision;
}
export function changedEnvironment(
  current: RuntimeEnvironmentRecord | null,
  expected: RuntimeEnvironmentRecord,
): ServiceStageResult | undefined {
  if (!current || current.currentRevision !== expected.currentRevision)
    return { status: "needsRestart", reason: "stale-reference: environment revision changed" };
  const path = (value: string) =>
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (
    current.bindingId !== expected.bindingId ||
    identityKeyOf(current.scope) !== identityKeyOf(expected.scope) ||
    path(current.scope.workspacePath) !== path(expected.scope.workspacePath)
  )
    return { status: "blocked", reason: "scope-mismatch: service environment changed" };
  return undefined;
}
export async function releaseLease(owner: ServiceOwner): Promise<void> {
  if (!owner.lease) return;
  owner.release ??= owner.lease.release().catch((error) => {
    owner.release = undefined;
    throw error;
  });
  await owner.release;
}
/** 仅在同一 environmentId 短锁内调用；服务事实和环境 snapshot 共用 stateRevision。 */
export async function saveServiceFact(
  context: ServiceStageContext,
  receipt: ManagedServiceReceipt,
): Promise<ManagedServiceReceipt> {
  const record = await context.store.readEnvironment(receipt.environmentId);
  if (record) await context.store.saveEnvironment({ ...record, updatedAt: context.stamp() });
  const current = record ? await context.store.readEnvironment(receipt.environmentId) : null;
  const next = { ...receipt, stateRevision: current?.stateRevision ?? receipt.stateRevision };
  await context.store.saveServiceReceipt(next);
  return next;
}
export function markUnknown(receipt: ManagedServiceReceipt): ServiceStageResult {
  const reason = "process-unknown: this Host does not own the service process";
  // 无权 Host 不能覆盖另一 Host 的持久事实；只返回 unknown 安全投影，不信任历史 URL。
  return {
    status: "blocked",
    receipt: { ...receipt, state: "unknown", urls: [], healthCheckedAt: undefined, error: reason },
    reason,
  };
}
export async function recordExit(
  context: ServiceStageContext,
  receipt: ManagedServiceReceipt,
  owner: ServiceOwner,
  exitCode: number,
): Promise<void> {
  owner.exit = { exitCode };
  await context.store.lock(receipt.environmentId, async () => {
    const latest = await context.store.readServiceReceipt(receipt.environmentId, receipt.serviceId);
    // 根因：旧回调在锁外读写，可能覆盖新 generation，或在 close 后被迟到 running 复活。
    if (sameGeneration(latest, receipt) && !hasServiceExitProof(latest)) {
      await saveServiceFact(context, {
        ...latest,
        state: owner.failure || latest.state === "failed" ? "failed" : "stopped",
        urls: [],
        healthCheckedAt: undefined,
        stoppedAt: context.stamp(),
        exitCode,
        error: owner.failure,
      });
    }
  });
  await retireOwner(context, receipt, owner);
}
export async function retireOwner(
  context: ServiceStageContext,
  receipt: ManagedServiceReceipt,
  owner: ServiceOwner,
): Promise<void> {
  await releaseLease(owner);
  await context.ownerChannel?.remove(receipt);
}
export async function defaultProbe(value: string): Promise<boolean> {
  const origin = serviceUrlOrigin(value);
  if (!origin) return false;
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    });
    const finish = (healthy: boolean) => {
      socket.destroy();
      resolve(healthy);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}
export function safeFailure(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "port-bind-failed")
    return "port-bind-failed: service could not bind its declared ports";
  if (code === "cancelled") return "cancelled: service start was superseded or stopped";
  if (code === "resource-busy") return "resource-busy: service port lease is busy";
  if (code === "unhealthy") return "service startup did not verify every listening address";
  if (code === "stale-reference") return "stale-reference: frozen service context changed";
  return "service startup failed; no unverified process output is exposed";
}
export const failure = (code: string) => Object.assign(new Error(code), { code });
