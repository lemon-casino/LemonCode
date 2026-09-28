import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { LCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS, type LCodeMcpResourceSample } from "@lcode/shared";
import {
  createProcessProbe,
  type ProcessProbe,
  type ProcessProbeSample,
  type ProcessTreeScope,
} from "../device/process-probe.js";

interface TimerHandle {
  unref?(): void;
}
export interface McpResourceTimer {
  clearInterval(handle: TimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): TimerHandle;
}

export interface McpResourceProcess {
  instanceId: string;
  mcpId: string;
  pid: number;
  startedAt: number;
  /** 探针 await 期间重启或注销的旧实例不能贡献资源或修改 tracker。 */
  isCurrent(): boolean;
  observed(
    samples: readonly ProcessProbeSample[] | undefined,
    sampledAt: number,
    scope: ProcessTreeScope,
  ): void;
}

export interface McpResourceTelemetryOptions {
  arch: LCodeMcpResourceSample["arch"];
  platform: LCodeMcpResourceSample["platform"];
  now(): number;
  getProcesses(): McpResourceProcess[];
  onResourceSamples?(samples: LCodeMcpResourceSample[]): void;
  processProbe?: ProcessProbe;
  logicalCpuCount?: number;
  totalMemoryGb?: number;
  timer?: McpResourceTimer;
}

/** 一个 tracker 一个定时器和探针；CPU 基线只活到下次采样，不保存历史序列。 */
export function createMcpResourceTelemetry(options: McpResourceTelemetryOptions) {
  const probe = options.processProbe ?? createProcessProbe({ platform: options.platform });
  const logicalCpuCount = options.logicalCpuCount ?? Math.max(1, cpus().length);
  const totalMemoryGb = options.totalMemoryGb ?? Math.round(totalmem() / 1024 ** 3);
  const instanceToken = randomUUID();
  const timer = options.timer ?? {
    setInterval: (callback: () => void, intervalMs: number) => setInterval(callback, intervalMs),
    clearInterval: (handle: TimerHandle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  let handle: TimerHandle | undefined;
  let generation = 0;
  let inFlight = false;
  let previousAt: number | undefined;
  let previous = new Map<string, Map<number, number>>();

  const sampleNow = async (): Promise<void> => {
    if (inFlight) return;
    const processes = options.getProcesses();
    if (processes.length === 0) {
      previous.clear();
      previousAt = undefined;
      return;
    }
    inFlight = true;
    const sampleGeneration = generation;
    const sampledAt = options.now();
    try {
      probe.reset();
      const trees = await probe.sampleProcessTrees(processes.map((entry) => entry.pid));
      if (sampleGeneration !== generation) return;
      if (!trees) {
        previous.clear();
        previousAt = undefined;
        return;
      }
      const intervalMs =
        previousAt === undefined
          ? LCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS
          : Math.max(1, sampledAt - previousAt);
      const next = new Map<string, Map<number, number>>();
      const groups = new Map<string, LCodeMcpResourceSample>();
      const seenPids = new Set<number>();
      for (const entry of processes) {
        if (!entry.isCurrent()) continue;
        const tree = trees.get(entry.pid);
        entry.observed(tree, sampledAt, probe.treeScope);
        if (!tree?.length) continue;
        const group = groups.get(entry.mcpId) ?? {
          mcpId: entry.mcpId,
          instanceToken,
          sampledAt,
          intervalMs,
          processCount: 0,
          rssKbTotal: 0,
          rssKbMaxProcess: 0,
          cpuTimeMsDelta: 0,
          uptimeMinutes: 0,
          platform: options.platform,
          arch: options.arch,
          logicalCpuCount,
          totalMemoryGb,
        };
        const baseline = new Map<number, number>();
        for (const sample of tree) {
          // 共享根或嵌套根只计一次，防止同一 OS 进程污染应用总量。
          if (seenPids.has(sample.pid)) continue;
          seenPids.add(sample.pid);
          group.processCount += 1;
          group.rssKbTotal += sample.rssKb;
          group.rssKbMaxProcess = Math.max(group.rssKbMaxProcess, sample.rssKb);
          if (sample.cpuTimeMs !== undefined) {
            baseline.set(sample.pid, sample.cpuTimeMs);
            const old = previous.get(entry.instanceId)?.get(sample.pid);
            if (old !== undefined) group.cpuTimeMsDelta += Math.max(0, sample.cpuTimeMs - old);
          }
        }
        next.set(entry.instanceId, baseline);
        group.uptimeMinutes = Math.max(
          group.uptimeMinutes,
          Math.floor(Math.max(0, sampledAt - entry.startedAt) / 60_000),
        );
        if (group.processCount > 0) groups.set(entry.mcpId, group);
      }
      previous = next;
      previousAt = sampledAt;
      if (groups.size > 0) options.onResourceSamples?.([...groups.values()]);
    } catch {
      // 采样/通知失败不能影响 MCP 生命周期，也不能把跨失败窗口的 CPU 时间算成五分钟均值。
      previous.clear();
      previousAt = undefined;
    } finally {
      inFlight = false;
    }
  };
  return {
    sampleNow,
    start() {
      if (handle) return;
      try {
        handle = timer.setInterval(() => {
          void sampleNow();
        }, LCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS);
        handle.unref?.();
      } catch {
        // 保持原 tracker 的旁路语义：定时器不可用不能阻断 MCP 连接。
      }
    },
    stop() {
      generation += 1;
      previous.clear();
      previousAt = undefined;
      const activeHandle = handle;
      handle = undefined;
      try {
        if (activeHandle) timer.clearInterval(activeHandle);
      } catch {
        // 清理失败不阻断 Agent 退出；上面的代际已使在途结果失效。
      }
    },
  };
}
