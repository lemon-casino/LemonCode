import type { ManagedServiceReceipt } from "@lcode/shared";

/**
 * 托管服务模型（spec: specs/worktree-runtime-environments.md §12.1/§12.4，M3 P3-01/P3-02）。
 * 纯领域规则：服务定义、代际、并发 start 裁决。
 * 资源租约实现（跨进程文件锁）在 app/ports.ts——domain 层禁 IO。
 * 锁顺序：环境锁 → 服务锁 → 端口锁（spec §12.4）。
 */

export interface ServiceDefinition {
  /** 稳定服务 ID（同环境内唯一），如 "dev-server"。 */
  serviceId: string;
  purpose: string;
  argv: string[];
  cwd: string;
  /** 服务声明的端口需求；预留 → 真实 bind 才算数（spec §12.2）。 */
  ports?: number[];
  /** 依赖的服务 ID（DAG）；部分失败不能把全组标 ready。 */
  dependsOn?: string[];
  /** 是否写源码；写源码服务需 checkout writer 许可（spec §12.4）。 */
  writesSource?: boolean;
}

/** 同环境同服务并发 start 返回同一收据（spec §12.1）；generation 随旧进程停止递增。 */
export function nextGenerationAfter(previous: ManagedServiceReceipt | null): number {
  return (previous?.generation ?? 0) + 1;
}

/**
 * 并发 start 裁决（spec §12.1）：同环境同服务已有 starting/running 收据时直接复用，
 * 不重复起进程；revision 不同返回 needsRestart，由调用方明确 stop 后重新 start。
 */
export function reconcileStartIntent(params: {
  existing: ManagedServiceReceipt | null;
  requestedRevision: number;
}): { action: "reuse" | "start" | "needsRestart"; receipt?: ManagedServiceReceipt } {
  const { existing, requestedRevision } = params;
  if (!existing) return { action: "start" };
  if (existing.state === "starting" || existing.state === "running") {
    if (existing.revision !== requestedRevision) return { action: "needsRestart" };
    return { action: "reuse", receipt: existing };
  }
  return { action: "start" };
}
