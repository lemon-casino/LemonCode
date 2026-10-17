import { readFile } from "node:fs/promises";
import { availableParallelism, freemem, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MIB = 1024 * 1024;
const LOW_MEMORY_LIMIT = 2048 * MIB;
export const RUNTIME_MEMORY_SYSTEM_HEADROOM_BYTES = 128 * MIB;
const AGENT_RESERVATION = 512 * MIB;
const WORKER_RESERVATION = 192 * MIB;

export interface RuntimeMemorySnapshot {
  limitBytes: number;
  availableBytes: number;
}
export interface RuntimeMemoryLease {
  heapMb: number;
  release(): void;
}
export type RuntimeMemoryRole = "agent" | "repl-worker";
export function resolveRuntimeHeapMb(role: RuntimeMemoryRole, limitBytes: number): number {
  const lowMemory = limitBytes <= LOW_MEMORY_LIMIT;
  return role === "agent" ? (lowMemory ? 256 : 512) : lowMemory ? 96 : 192;
}

export class RuntimeMemoryBudgetError extends Error {
  readonly code = "RUNTIME_MEMORY_BUDGET_EXCEEDED";
  constructor(role: RuntimeMemoryRole) {
    super(
      `Runtime memory budget is insufficient for ${role}. Close an unused workspace or retry after the current operation completes.`,
    );
    this.name = "RuntimeMemoryBudgetError";
  }
}

/** Node 的 availableMemory 在部分系统只反映宿主；Linux 还须逐级读取真实 cgroup 余量。 */
export async function readRuntimeMemorySnapshot(): Promise<RuntimeMemorySnapshot> {
  const constrained = process.constrainedMemory?.() ?? 0;
  let limitBytes = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
  let availableBytes = process.availableMemory?.() || freemem();
  if (process.platform === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
    const available = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo);
    if (available) availableBytes = Math.min(availableBytes, Number(available[1]) * 1024);
    const membership = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
    const relative = /^0::(.*)$/m.exec(membership)?.[1];
    const root = "/sys/fs/cgroup";
    if (relative !== undefined) {
      let directory = resolve(root, "." + relative);
      while (directory === root || directory.startsWith(root + "/")) {
        const [max, current] = await Promise.all([
          readFile(join(directory, "memory.max"), "utf8").catch(() => "max"),
          readFile(join(directory, "memory.current"), "utf8").catch(() => "0"),
        ]);
        const maximum = Number(max.trim());
        if (Number.isFinite(maximum) && maximum > 0) {
          limitBytes = Math.min(limitBytes, maximum);
          availableBytes = Math.min(availableBytes, Math.max(0, maximum - Number(current.trim())));
        }
        if (directory === root) break;
        directory = dirname(directory);
      }
    }
  }
  return { limitBytes, availableBytes: Math.min(limitBytes, availableBytes) };
}

/** 只拥有未释放的资源预留，不拥有业务队列；同一 Host 的全部 manager 共用实例。 */
export function createRuntimeMemoryBudget(probe = readRuntimeMemorySnapshot) {
  const leases = new Map<symbol, { role: RuntimeMemoryRole; bytes: number }>();
  let admission = Promise.resolve();
  return {
    async acquire(role: RuntimeMemoryRole): Promise<RuntimeMemoryLease> {
      const previous = admission;
      const barrier = Promise.withResolvers<void>();
      admission = barrier.promise;
      await previous;
      try {
        const snapshot = await probe();
        const lowMemory = snapshot.limitBytes <= LOW_MEMORY_LIMIT;
        const bytes = role === "agent" ? AGENT_RESERVATION : WORKER_RESERVATION;
        const reserved = [...leases.values()].reduce((sum, lease) => sum + lease.bytes, 0);
        const workers = [...leases.values()].filter((lease) => lease.role === "repl-worker").length;
        const maxWorkers = lowMemory ? 1 : Math.max(1, Math.min(4, availableParallelism() - 1));
        const capacity =
          snapshot.limitBytes - RUNTIME_MEMORY_SYSTEM_HEADROOM_BYTES - process.memoryUsage.rss();
        if (
          reserved + bytes > capacity ||
          snapshot.availableBytes < bytes + RUNTIME_MEMORY_SYSTEM_HEADROOM_BYTES ||
          (role === "repl-worker" && workers >= maxWorkers)
        ) {
          throw new RuntimeMemoryBudgetError(role);
        }
        const token = Symbol(role);
        leases.set(token, { role, bytes });
        return {
          heapMb: resolveRuntimeHeapMb(role, snapshot.limitBytes),
          release: () => {
            leases.delete(token);
          },
        };
      } finally {
        barrier.resolve();
      }
    },
  };
}

export const runtimeMemoryBudget = createRuntimeMemoryBudget();

/** NODE_OPTIONS 是已有 Node 合同；保留其它参数并将安全上限放在最后。显式更小值保留。 */
export function withRuntimeHeapLimit(nodeOptions: string | undefined, heapMb: number): string {
  const configured = [
    ...(nodeOptions ?? "").matchAll(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/g),
  ].map((match) => Number(match[1]));
  const effective = Math.min(heapMb, ...configured.filter((value) => value > 0));
  return `${nodeOptions ?? ""} --max-old-space-size=${effective}`.trim();
}
