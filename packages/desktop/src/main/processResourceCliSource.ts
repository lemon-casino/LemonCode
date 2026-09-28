/**
 * lcode-cli 角色（`cli_chat` / `cli_aux`）的资源样本来源（注册表第五行）。
 *
 * 每个 CLI 进程每 60 秒自采一次，经协议通知交给 services（在那里按所属进程管理器打上 lane），
 * 再由 Host 转发到 main。这里按「角色 × runtime_surface × 进程实例」保留每个进程最近一次读数，
 * 每 60 秒把当前存活进程的合计交给窗口聚合器：
 *
 * - 为什么不是每个 10 秒 tick 交一次：CLI 是 60 秒口径，按 tick 交会把同一份读数重复计入统计量，
 *   `sample_count` 也会从预期的 5 变成 30。
 * - 为什么不是「到达即交、交付即清空」（host / renderer heap 的做法）：多个 CLI 进程的 60 秒定时器
 *   各自相位，一个 tick 通常只收到其中一部分进程的读数，那样 `process_count_peak` 与总量都会偏小。
 *   角色事件要的恰恰是「同时存活几个进程、合计多少」，因此必须保留每进程的最近读数。
 * - 过期判据与设备级外部样本一致：超过两个采样周期没有新读数即认为进程已退出，不再计入。
 *   宁可少算，也不拿旧值充当当前事实。
 * - 只在「有新读数」时交付，因此同一份读数不会被两次交付重复计入统计量。
 * - 正常退出走 `flushPending`：把已经收到、还没赶上 60 秒交付点的读数补交给窗口
 *   （只搬已有事实，不做新采样）。
 *
 * 隐私边界：`instanceToken` 只在本模块内存里用于区分进程，不进任何 ARMS 属性；样本不含 pid。
 */

import {
  agentLaneResourceSampleSchema,
  resolveCliProcessResourceRole,
  LCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type AgentLaneResourceSample,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
} from "@lcode/shared";
import { recordExternalAppResourceSample } from "./processResourceExternalAppSamples.js";
import type {
  ProcessResourceSampleContext,
  ProcessResourceSampleSource,
} from "./processResourceSampleSources.js";
import {
  processResourceHardwareKey,
  type ProcessResourceHardwareOverride,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import { roundMetric } from "./resourceMetricsStats.js";

/**
 * 同时跟踪的 CLI 进程数上限（内存有界）。
 * 正常形态是每 workspace 一个 chat 进程加三条控制面 lane，64 远超实际；超出后新进程直接丢弃。
 */
const PROCESS_RESOURCE_MAX_CLI_INSTANCES = 64;

/** 无 instanceToken 的旧 CLI 样本共用一个桶：无法区分进程，只能按一个进程计。 */
const LEGACY_INSTANCE_KEY = "legacy";

interface StoredCliSample {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  sample: AgentLaneResourceSample;
  /** 到达时刻，只用于过期判定。 */
  receivedAt: number;
  /**
   * 这条读数是否已经交给窗口聚合器。
   * 用显式标记而不是比时间戳：读数与交付撞在同一毫秒时，比时间戳会把它误判成已交付而永久丢弃。
   */
  delivered: boolean;
}

const latestSamplesByInstance = new Map<string, StoredCliSample>();

/**
 * main 侧的信任边界：payload 经 Host 响应 schema 严格校验后到这里，这里再校验一次
 * （scheduler / 远端 relay 等其他链路复用同一入口）。非法样本直接丢弃，不抛错。
 */
export function ingestCliResourceSample(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
  environmentKey?: string,
): void {
  const parsed = agentLaneResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const sample = parsed.data;
  const role = resolveCliProcessResourceRole(sample.lane);
  const key = [
    role,
    runtimeSurface,
    environmentKey ?? "",
    sample.instanceToken ?? LEGACY_INSTANCE_KEY,
  ].join(":");
  if (
    !latestSamplesByInstance.has(key) &&
    latestSamplesByInstance.size >= PROCESS_RESOURCE_MAX_CLI_INSTANCES
  ) {
    return;
  }
  const receivedAt = Date.now();
  latestSamplesByInstance.set(key, {
    role,
    runtimeSurface,
    environmentKey,
    sample,
    receivedAt,
    delivered: false,
  });
  // 设备总量以实例保存原始到达时间；用组的交付时间会让停更实例被其他组或同组活跃实例续期。
  recordExternalAppResourceSample({
    sourceKey: `cli:${key}`,
    runtimeSurface,
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKb,
    processCount: 1,
    intervalMs: resolveSampleIntervalMs(sample),
    receivedAt,
  });
}

/** 采样周期至少按 CLI 自采周期计：读数间隔异常小时不能把过期窗口跟着缩短。 */
function resolveSampleIntervalMs(sample: AgentLaneResourceSample): number {
  return Math.max(LCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS, sample.intervalMs);
}

function resolveHardware(sample: AgentLaneResourceSample): ProcessResourceHardwareOverride {
  return {
    platform: sample.platform,
    arch: sample.arch,
    logicalCpuCount: sample.logicalCpuCount,
    // 旧 CLI 不带运行机内存，缺省由出口补桌面机的值。
    ...(sample.totalMemoryGb === undefined ? {} : { totalMemoryGb: sample.totalMemoryGb }),
  };
}

/** 丢弃超过两个采样周期没有新读数的进程条目。 */
function purgeExpired(now: number): void {
  for (const [key, entry] of latestSamplesByInstance) {
    if (now - entry.receivedAt > resolveSampleIntervalMs(entry.sample) * 2) {
      latestSamplesByInstance.delete(key);
    }
  }
}

interface CliRoleGroup {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  /** 本组共同的运行机：它进了分组 key，因此组内每个进程的运行机信息完全一致。 */
  hardware: ProcessResourceHardwareOverride;
  samples: AgentLaneResourceSample[];
  fresh: boolean;
}

/**
 * 分组 key：角色 × runtime_surface × 运行机。
 * 加运行机是因为多个远端 workspace 可能跑在不同机器上，它们的 RSS 不能相加、
 * 硬件维度也只能描述一台机器（聚合器的窗口 key 用同一个指纹分窗）。
 */
function groupByRole(): CliRoleGroup[] {
  const groups = new Map<string, CliRoleGroup>();
  for (const entry of latestSamplesByInstance.values()) {
    const hardware = resolveHardware(entry.sample);
    // 硬件相同并不代表运行环境相同，Host 注入的身份必须贯穿实例缓存和分组。
    const key = [
      entry.role,
      entry.runtimeSurface,
      entry.environmentKey ?? "",
      processResourceHardwareKey(hardware),
    ].join(":");
    const group = groups.get(key);
    if (group) {
      group.samples.push(entry.sample);
      group.fresh ||= !entry.delivered;
      continue;
    }
    groups.set(key, {
      role: entry.role,
      runtimeSurface: entry.runtimeSurface,
      environmentKey: entry.environmentKey,
      hardware,
      samples: [entry.sample],
      fresh: !entry.delivered,
    });
  }
  return [...groups.values()];
}

function projectRoleSample(group: CliRoleGroup): ProcessRoleSample {
  let cpuPercent = 0;
  let rssKbTotal = 0;
  let rssKbMaxProcess = 0;
  let uptimeMinutes = 0;
  let heapUsedKb: number | undefined;
  for (const sample of group.samples) {
    cpuPercent += sample.cpuPercent;
    rssKbTotal += sample.rssKb;
    rssKbMaxProcess = Math.max(rssKbMaxProcess, sample.rssKb);
    uptimeMinutes = Math.max(uptimeMinutes, sample.uptimeMinutes ?? 0);
    // 多进程角色的 heap 取本次采样的最大单进程。
    if (sample.heapUsedKb !== undefined) {
      heapUsedKb = Math.max(heapUsedKb ?? 0, sample.heapUsedKb);
    }
  }

  return {
    role: group.role,
    runtimeSurface: group.runtimeSurface,
    ...(group.environmentKey === undefined ? {} : { environmentKey: group.environmentKey }),
    // CPU 只在相加结束后取整，逐次 round 会让误差随进程数累积。
    cpuPercent: roundMetric(cpuPercent),
    rssKbTotal: roundMetric(rssKbTotal),
    rssKbMaxProcess: roundMetric(rssKbMaxProcess),
    processCount: group.samples.length,
    uptimeMinutes,
    ...(heapUsedKb === undefined ? {} : { heapUsedKb }),
    hardware: group.hardware,
  };
}

/** 上次把角色样本交给窗口聚合器的时刻（`context.now`，与 ingest 的 `Date.now()` 同一墙钟）。 */
let lastDeliveredAt: number | null = null;

/** 是否有「已经收到但还没交出去」的读数：没有新读数就不该再交一次同样的事实。 */
function hasUndeliveredReading(): boolean {
  for (const entry of latestSamplesByInstance.values()) {
    if (!entry.delivered) {
      return true;
    }
  }
  return false;
}

/** 把含有新读数的存活进程组合交给角色窗口；设备总量在摄入时按实例独立维护。 */
function deliverRoleSamples(context: ProcessResourceSampleContext): void {
  lastDeliveredAt = context.now;
  // 先读取各组的新读数标记再封口；全局有新读数不代表每组都有，旧组不能被带着续期。
  const groups = groupByRole();
  for (const entry of latestSamplesByInstance.values()) {
    entry.delivered = true;
  }
  for (const group of groups) {
    if (!group.fresh) continue;
    context.addRoleSample(projectRoleSample(group));
  }
}

export const cliProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "cli",
  sample(context) {
    purgeExpired(context.now);
    // 60 秒交一次，且只在有新读数时交：窗口切分权仍在 main 的 flush 时钟上，
    // 这里只决定「多久算一个 CLI 样本」，同一份读数不会被计入两次统计量。
    if (
      lastDeliveredAt !== null &&
      context.now - lastDeliveredAt < LCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  flushPending(context) {
    // 正常退出：把本周期已经收到、还没赶上 60 秒交付点的读数交出去，
    // 否则 1 分钟窗口（开发态 / E2E）里退出会让 cli 角色一条事件都没有。
    purgeExpired(context.now);
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  reset() {
    latestSamplesByInstance.clear();
    lastDeliveredAt = null;
  },
};
