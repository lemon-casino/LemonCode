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
  /** 仅可信项目定义/组合根下发；客户端不能提交任意 env 或 argv。 */
  env?: Record<string, string>;
  /** 服务声明的端口需求；0 由进程 adapter 分配 loopback ephemeral，真实 bind 才算数。 */
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

/** failed/stopped 标签本身不是退出证明；缺 stoppedAt 时保留 owner 和资源。 */
export function hasServiceExitProof(receipt: ManagedServiceReceipt): boolean {
  return (receipt.state === "stopped" || receipt.state === "failed") && Boolean(receipt.stoppedAt);
}

/** 同代复用还需 app 层确认本 Host 的 owner；仅凭持久 PID/URL 不能认领进程。 */
export function reconcileStartIntent(params: {
  existing: ManagedServiceReceipt | null;
  requestedRevision: number;
  expectedGeneration?: number;
}): { action: "reuse" | "start" | "needsRestart" | "blocked"; receipt?: ManagedServiceReceipt } {
  const { existing, requestedRevision, expectedGeneration } = params;
  if (expectedGeneration !== undefined && expectedGeneration !== existing?.generation)
    return { action: "needsRestart", receipt: existing ?? undefined };
  if (!existing || hasServiceExitProof(existing)) return { action: "start" };
  if (existing.revision !== requestedRevision) return { action: "needsRestart", receipt: existing };
  if (existing.state === "starting" || existing.state === "running")
    return { action: "reuse", receipt: existing };
  // 根因：旧实现把 stopping/failed/unknown 全部当可启动，可能让同环境存在两个活进程树。
  return { action: "blocked", receipt: existing };
}

/** 对外仅发布无凭据的 loopback origin，日志路径、查询参数和 token 不进入收据。 */
export function serviceUrlOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
