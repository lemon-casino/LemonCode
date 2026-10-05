import { isIP } from "node:net";
import type { ManagedServiceReceipt, RuntimeEnvironmentRecord } from "@lcode/shared";
import type { ServiceDefinition } from "../domain/services.js";
import { nextGenerationAfter, reconcileStartIntent } from "../domain/services.js";
import type { RuntimeEnvironmentStore, ServiceProcessPort } from "./ports.js";

/**
 * 托管服务 start/stop/健康/停止证明（spec: specs/worktree-runtime-environments.md §12.1/§12.2，M3 P3-02）。
 * running 必须有真实监听证据（TCP connect 实际 bind 地址，探测候选不算）；
 * stopped 必须有进程 owner 退出证明；PID 仅诊断不授权停止。
 * 并发 start 同收据；revision 变化返回 needsRestart，不超时强替（spec §6.2）。
 */

export interface ServiceStageContext {
  store: RuntimeEnvironmentStore;
  processes?: ServiceProcessPort;
  /** TCP 健康探测；测试注入。缺省用 node:net connect。 */
  probe?: (url: string) => Promise<boolean>;
  /**
   * 端口资源租约（spec §12.2，M3 P3-03）：start 前加锁、进程 owner 结算后释放；
   * 同机跨窗口经持久锁协调。缺省 = 不加租约（单窗口场景）。
   */
  acquireLease?: (params: { resourceKey: string; ownerId: string }) => Promise<{
    token: string;
    release: () => Promise<void>;
  }>;
  stamp: () => string;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** TCP connect 探测实际监听（spec §12.2：探测候选不等同监听，这里对真实 URL 验证）。 */
async function defaultProbe(url: string): Promise<boolean> {
  if (!isLoopbackUrl(url)) return true; // 非本地地址不做 TCP 探测，仅格式校验。
  const parsed = new URL(url);
  const port = Number(parsed.port);
  if (
    !Number.isFinite(port) ||
    (!isIP(parsed.hostname.replace(/^\[|\]$/g, "")) && parsed.hostname !== "localhost")
  )
    return true;
  const { connect } = await import("node:net");
  return new Promise((resolvePromise) => {
    const socket = connect({
      port,
      host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname.replace(/^\[|\]$/g, ""),
    });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

export async function startManagedService(
  context: ServiceStageContext,
  record: RuntimeEnvironmentRecord,
  definition: ServiceDefinition,
): Promise<
  | { status: "started" | "reused"; receipt: ManagedServiceReceipt }
  | { status: "needsRestart" | "failed"; receipt?: ManagedServiceReceipt; reason?: string }
> {
  const previous = await context.store.readServiceReceipt(
    record.environmentId,
    definition.serviceId,
  );
  const intent = reconcileStartIntent({
    existing: previous,
    requestedRevision: record.currentRevision,
  });
  if (intent.action === "reuse") return { status: "reused", receipt: intent.receipt! };
  if (intent.action === "needsRestart")
    return { status: "needsRestart", receipt: previous ?? undefined };
  if (!context.processes)
    return { status: "failed", reason: "service process port is not available on this Host" };
  if (definition.writesSource)
    return {
      status: "failed",
      reason: "source-writing services require the checkout writer permit (spec §12.4)",
    };

  const generation = nextGenerationAfter(previous);
  const startedAt = context.stamp();
  // 端口资源租约（spec §12.2 M3 P3-03）：与 checkout writer 许可分开（spec §12.4）；
  // 拿不到锁 = 另一窗口的真实 writer 在跑，明确失败不排队强抢。
  let lease: { release: () => Promise<void> } | undefined;
  if (context.acquireLease) {
    try {
      lease = await context.acquireLease({
        resourceKey: `service-port:${record.environmentId}:${definition.serviceId}`,
        ownerId: `service:${record.environmentId}:${definition.serviceId}`,
      });
    } catch (error) {
      return {
        status: "failed",
        reason: `service port lease is busy: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const starting: ManagedServiceReceipt = {
    environmentId: record.environmentId,
    revision: record.currentRevision,
    serviceId: definition.serviceId,
    generation,
    state: "starting",
    urls: [],
    startedAt,
  };
  await context.store.saveServiceReceipt(starting);
  let handle;
  try {
    handle = await context.processes.start({
      environmentId: record.environmentId,
      serviceId: definition.serviceId,
      generation,
      argv: definition.argv,
      cwd: definition.cwd,
    });
  } catch (error) {
    const failed: ManagedServiceReceipt = {
      ...starting,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    await context.store.saveServiceReceipt(failed);
    // 进程未起成：立即释放端口租约，不占用资源等下一轮。
    await lease?.release().catch(() => {});
    return { status: "failed", receipt: failed, reason: failed.error };
  }
  // 真实监听验证（spec §12.2 第 3/6 步）：对进程回报的 URL 逐个 TCP 探测，全部通过才标 running。
  const probe = context.probe ?? defaultProbe;
  const verified: string[] = [];
  for (const url of handle.urls) {
    if (await probe(url)) verified.push(url);
  }
  if (handle.urls.length > 0 && verified.length === 0) {
    // 一个地址都没验证通过：不标 running（无虚假 ready），按 failed 结算等待显式重试。
    const stopped = await context.processes.stop({
      environmentId: record.environmentId,
      serviceId: definition.serviceId,
      generation,
      pid: handle.pid,
    });
    const failed: ManagedServiceReceipt = {
      ...starting,
      state: "failed",
      urls: [...handle.urls],
      pid: handle.pid,
      error: "no listening address verified",
      exitCode: stopped?.exitCode,
      stoppedAt: stopped ? context.stamp() : undefined,
    };
    await context.store.saveServiceReceipt(failed);
    await lease?.release().catch(() => {});
    return { status: "failed", receipt: failed };
  }
  const running: ManagedServiceReceipt = {
    ...starting,
    state: "running",
    urls: verified,
    pid: handle.pid,
    healthCheckedAt: context.stamp(),
  };
  await context.store.saveServiceReceipt(running);
  void context.processes.onExit?.(
    { environmentId: record.environmentId, serviceId: definition.serviceId, generation },
    async (exitCode) => {
      // 进程 owner 的退出证明落盘：running 收据不得在进程死后继续存在（spec §12.1）。
      // 租约与进程同生命周期：退出即释放端口资源（spec §12.2）。
      const latest = await context.store.readServiceReceipt(
        record.environmentId,
        definition.serviceId,
      );
      if (latest && latest.generation === generation) {
        await context.store.saveServiceReceipt({
          ...latest,
          state: "stopped",
          stoppedAt: context.stamp(),
          exitCode,
        });
      }
      await lease?.release().catch(() => {});
    },
  );
  return { status: "started", receipt: running };
}

export async function stopManagedService(
  context: ServiceStageContext,
  record: RuntimeEnvironmentRecord,
  serviceId: string,
): Promise<
  | { status: "stopped"; receipt: ManagedServiceReceipt }
  | { status: "notRunning" | "stopFailed"; receipt?: ManagedServiceReceipt; reason?: string }
> {
  const current = await context.store.readServiceReceipt(record.environmentId, serviceId);
  if (!current || ["stopped", "failed"].includes(current.state))
    return { status: "notRunning", receipt: current ?? undefined };
  if (current.state === "stopping") return { status: "stopFailed", receipt: current };
  if (!context.processes) return { status: "stopFailed", reason: "process port unavailable" };
  const stopping: ManagedServiceReceipt = { ...current, state: "stopping" };
  await context.store.saveServiceReceipt(stopping);
  try {
    const result = await context.processes.stop({
      environmentId: record.environmentId,
      serviceId,
      generation: current.generation,
      pid: current.pid,
    });
    // 停止证明来自进程 owner（spec §7 规则 7）；无退出结果不标 stopped。
    const stopped: ManagedServiceReceipt = {
      ...stopping,
      state: result ? "stopped" : "failed",
      stoppedAt: result ? context.stamp() : undefined,
      exitCode: result?.exitCode,
      ...(result ? {} : { error: "process owner did not confirm exit" }),
    };
    await context.store.saveServiceReceipt(stopped);
    return result
      ? { status: "stopped", receipt: stopped }
      : { status: "stopFailed", receipt: stopped };
  } catch (error) {
    const failed: ManagedServiceReceipt = {
      ...stopping,
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    await context.store.saveServiceReceipt(failed);
    return { status: "stopFailed", receipt: failed };
  }
}
