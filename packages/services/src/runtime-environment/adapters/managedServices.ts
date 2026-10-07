import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "@lcode/services/process/processTreeTerminator";
import type { ServiceProcessPort } from "../app/ports.js";
import {
  createServiceOutput,
  managedProcessError,
  probeServiceListener,
  reserveLoopbackPorts,
  withinBudget,
} from "./managedServiceIo.js";

export interface ManagedServiceProcessDefinition {
  /** 与 start.ports 位置对应；未指定端口/0 分配真实 loopback ephemeral 候选。 */
  portEnvironment?: readonly string[];
}
export interface ManagedServiceProcessOptions {
  definitions?: Readonly<Record<string, ManagedServiceProcessDefinition>>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** 测试/组合根替换停止策略；只接收本 owner 的原 ChildProcess，不接收裸 PID。 */
  terminateTree?: (child: ChildProcess) => Promise<boolean>;
}
type Key = Pick<
  Parameters<ServiceProcessPort["start"]>[0],
  "environmentId" | "serviceId" | "generation"
>;
type Proof = { exitCode?: number };
type StartResult = Awaited<ReturnType<ServiceProcessPort["start"]>>;
type ExitCallback = (exitCode: number) => Promise<void>;
interface Entry {
  key: Key;
  child?: ChildProcess;
  startedAt: number;
  exitedAt?: number;
  close: ReturnType<typeof Promise.withResolvers<Proof>>;
  closed?: Proof;
  proven?: Proof;
  issued: ReturnType<typeof Promise.withResolvers<void>>;
  cancelled: boolean;
  ready: Promise<StartResult>;
  stopping?: Promise<Proof | undefined>;
  notified: Set<ExitCallback>;
  callbacks: Set<ExitCallback>;
  callbackFlights: Map<ExitCallback, Promise<void>>;
  dispose?: () => void;
}
const baseKey = (key: Key) => JSON.stringify([key.environmentId, key.serviceId]);
const fullKey = (key: Key) => JSON.stringify([key.environmentId, key.serviceId, key.generation]);
const alive = (entry: Entry) =>
  Boolean(
    entry.child &&
    !entry.closed &&
    entry.child.exitCode === null &&
    entry.child.signalCode === null,
  );

/**
 * spec §12：argv 属可信定义，ChildProcess 句柄属本 adapter；不采纳持久 PID/URL 作为 ownership。
 * 同 generation 单次 spawn；stdout bind + 全部健康 + child 存活才 ready，stop 等真实 close 与树退出。
 */
export function createManagedServiceProcesses(
  options: ManagedServiceProcessOptions = {},
): ServiceProcessPort & { isAlive(key: Key): boolean; disposeAndWait(): Promise<void> } {
  // 每环境/服务仅保留当前代的句柄或退出墓碑，旧回调持有原 entry，不可覆盖 registry 新代。
  const entries = new Map<string, Entry>();
  const waiting = new Map<string, Set<ExitCallback>>();
  const startupTimeout = options.startupTimeoutMs ?? 30_000;
  const stopTimeout = options.stopTimeoutMs ?? 8_000;
  let disposing = false;

  function notify(entry: Entry) {
    if (!entry.proven) return;
    for (const callback of entry.callbacks) {
      if (entry.notified.has(callback)) continue;
      entry.notified.add(callback);
      // 回调落盘独立于 close 屏障，stop 不能等待可能再次获取环境锁的业务回调。
      const flight = callback(entry.proven.exitCode ?? 1);
      entry.callbackFlights.set(callback, flight);
      void flight.catch(() => {
        entry.notified.delete(callback);
      });
    }
  }
  async function stopEntry(entry: Entry): Promise<Proof | undefined> {
    entry.cancelled = true;
    if (entry.proven) {
      notify(entry);
      return entry.proven;
    }
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      await entry.issued.promise;
      if (!entry.child) {
        entry.proven = entry.closed ?? {};
        entry.dispose?.();
        notify(entry);
        return entry.proven;
      }
      let treeStopped: boolean;
      try {
        treeStopped = options.terminateTree
          ? (await withinBudget(options.terminateTree(entry.child), stopTimeout)) === true
          : (
              await terminateProcessTreeAndWait(entry.child, {
                ownedProcessGroupId: process.platform === "win32" ? undefined : entry.child.pid,
                ownedProcessStartedAtMs: entry.startedAt,
                resolveOwnedProcessExitedAtMs: () => entry.exitedAt,
                forceAfterMs: 1_000,
                waitAfterForceMs: Math.max(1, stopTimeout - 1_000),
                windowsCleanupDeadlineAtMs: Date.now() + stopTimeout,
              })
            ).remainingPids.length === 0;
      } catch {
        treeStopped = false;
      }
      // 根因：kill() 成功、remainingPids=[] 或 root exit 都不是原 child 的 stdio close 证明。
      const closed = entry.closed ?? (await withinBudget(entry.close.promise, stopTimeout));
      if (!treeStopped || !closed) return undefined;
      entry.proven = closed;
      entry.dispose?.();
      notify(entry);
      return closed;
    })().finally(() => {
      entry.stopping = undefined;
    });
    return entry.stopping;
  }

  async function launch(
    entry: Entry,
    params: Parameters<ServiceProcessPort["start"]>[0],
  ): Promise<StartResult> {
    const config = options.definitions?.[params.serviceId];
    const portKeys = config?.portEnvironment ?? [];
    const abort = () => {
      entry.cancelled = true;
      void stopEntry(entry).catch(() => {});
    };
    params.signal?.addEventListener("abort", abort, { once: true });
    let output: ReturnType<typeof createServiceOutput> | undefined;
    entry.dispose = () => {
      params.signal?.removeEventListener("abort", abort);
      output?.clear();
    };
    try {
      if (
        portKeys.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name)) ||
        new Set(portKeys).size !== portKeys.length
      )
        throw managedProcessError("configuration-conflict");
      if (params.signal?.aborted || entry.cancelled) throw managedProcessError("cancelled");
      const ports = portKeys.length
        ? await reserveLoopbackPorts(portKeys.length, params.ports)
        : (params.ports ?? []);
      const env: NodeJS.ProcessEnv =
        params.env === undefined ? { ...process.env } : { ...params.env };
      for (let index = 0; index < portKeys.length; index++)
        env[portKeys[index]!] = String(ports[index]);
      // 本项目 server/frontend/proxy 使用同一组变量，默认只监听 loopback，不继承外部 HOST=0.0.0.0。
      if (portKeys.includes("LCODE_SERVER_PORT")) env.LCODE_SERVER_HOST = "localhost";
      if (params.signal?.aborted || entry.cancelled) throw managedProcessError("cancelled");
      const [command, ...argv] = params.argv;
      if (!command || /\.(cmd|bat)$/iu.test(command))
        throw managedProcessError("configuration-conflict");
      output = createServiceOutput(ports);
      entry.startedAt = Date.now();
      const child = spawn(command, argv, {
        cwd: params.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: shouldSpawnInDetachedProcessGroup(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      entry.child = child;
      let spawnFailed = false;
      child.stdout!.on("data", (chunk: Buffer) => output!.consume("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => output!.consume("stderr", chunk));
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("exit", () => {
        entry.exitedAt = Date.now();
        // 先观察到 root exit 时仍按原树所有权清理后代，不能按退出后的 PID 重新认领。
        void stopEntry(entry).catch(() => {});
      });
      child.once("close", (code, signal) => {
        entry.closed = { exitCode: code ?? (signal ? 128 : 1) };
        entry.close.resolve(entry.closed);
        if (!entry.stopping) void stopEntry(entry).catch(() => {});
      });
      entry.issued.resolve();
      if (params.signal?.aborted || entry.cancelled) abort();
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        if (params.signal?.aborted) throw managedProcessError("cancelled");
        if (output.bindFailed()) throw managedProcessError("port-bind-failed");
        if (spawnFailed || !alive(entry)) throw managedProcessError("spawn-failed");
        if (entry.cancelled) throw managedProcessError("cancelled");
        const urls = output.urls();
        if (urls.length && (await Promise.all(urls.map(probeServiceListener))).every(Boolean)) {
          if (alive(entry) && !entry.cancelled && !output.bindFailed()) {
            output.clear();
            return { pid: child.pid, urls };
          }
        }
        // 这是有界健康重试，不是靠超时伪造同步/退出事实；到期明确失败并停止原树。
        await delay(25);
      }
      throw managedProcessError("unhealthy");
    } catch (error) {
      if (!entry.child) {
        entry.closed = {};
        entry.close.resolve(entry.closed);
      }
      entry.issued.resolve();
      await stopEntry(entry);
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "spawn-failed";
      throw managedProcessError(code);
    }
  }

  return {
    isAlive(key) {
      const entry = entries.get(baseKey(key));
      return entry?.key.generation === key.generation && alive(entry) && !entry.cancelled;
    },
    start(params) {
      if (disposing) return Promise.reject(managedProcessError("cancelled"));
      const name = baseKey(params);
      const previous = entries.get(name);
      if (previous) {
        if (previous.key.generation === params.generation) return previous.ready;
        if (!previous.proven || previous.key.generation > params.generation)
          return Promise.reject(managedProcessError("process-unknown"));
      }
      const callbacks = waiting.get(fullKey(params)) ?? new Set<ExitCallback>();
      waiting.delete(fullKey(params));
      const entry: Entry = {
        key: {
          environmentId: params.environmentId,
          serviceId: params.serviceId,
          generation: params.generation,
        },
        startedAt: Date.now(),
        close: Promise.withResolvers<Proof>(),
        issued: Promise.withResolvers<void>(),
        cancelled: false,
        callbacks,
        callbackFlights: new Map(),
        notified: new Set(),
        ready: undefined!,
      };
      entries.set(name, entry);
      entry.ready = launch(entry, params);
      return entry.ready;
    },
    async stop(params) {
      const entry = entries.get(baseKey(params));
      // 持久 PID 只用于诊断；跨 Host、旧代和未知 owner 都不能调用 terminator。
      if (!entry || entry.key.generation !== params.generation) return undefined;
      return stopEntry(entry);
    },
    onExit(key, callback) {
      const entry = entries.get(baseKey(key));
      if (entry && entry.key.generation === key.generation) {
        entry.callbacks.add(callback);
        notify(entry);
        return;
      }
      const name = fullKey(key);
      const callbacks = waiting.get(name) ?? new Set<ExitCallback>();
      callbacks.add(callback);
      waiting.set(name, callbacks);
    },
    async disposeAndWait() {
      disposing = true;
      const proofs = await Promise.all([...entries.values()].map(stopEntry));
      // 未确认的原句柄保留供 shutdown 重试；不能清 registry 后把未知残留当已释放。
      if (proofs.some((proof) => !proof)) throw managedProcessError("process-unknown");
      // Host 退出前等待收据/租约结算，不能 close 成功后留下旧 running 快照。
      await Promise.all(
        [...entries.values()].flatMap((entry) => [...entry.callbackFlights.values()]),
      );
      waiting.clear();
    },
  };
}
