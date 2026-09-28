/**
 * 资源样本来源注册表的类型与调度。
 *
 * 每个来源是一个独立文件，只往注册表里加一行；来源之间互不知情，
 * 单个来源采样失败只丢它自己的样本（失败即丢，不阻塞业务）。
 */

import type { ProcessResourceRole } from "@lcode/shared";
import type { AppResourceTotals } from "./processResourceAppTotals.js";
import type { DeviceResourceSample } from "./processResourceSystemWindowAggregator.js";
import type { ProcessRoleSample } from "./processResourceWindowAggregator.js";

export interface ProcessResourceSampleContext {
  /** 本次 tick 的墙钟时间，来源共用同一个读数，避免同 tick 内时间漂移。 */
  now: number;
  addRoleSample: (sample: ProcessRoleSample) => void;
  /**
   * 只贡献 heap 读数、不构成完整角色样本的来源用这个钩子
   * （host / scheduler 自采、renderer）。heap 会并入同一 tick 内该角色的完整样本；
   * 该角色本 tick 没有完整样本时这次读数丢弃——heap 只是角色事件的附加维度，不足以独立开窗。
   */
  addRoleHeapSample: (role: ProcessResourceRole, heapUsedKb: number) => void;
  /**
   * 本 tick 内能被 main 精确枚举的应用进程合计（目前只有 Chromium 体系）。
   * 设备级来源在第二阶段读它算应用总量，因此这里的合计不能和外部样本入口重复计数。
   */
  addAppProcessTotals: (totals: AppResourceTotals) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

/**
 * 设备级采样（第二阶段）的上下文：依赖同一 tick 内第一阶段已经采到的事实。
 * 两个阶段分开跑，来源之间就不需要靠调用顺序或模块级变量传值。
 */
export interface ProcessResourceDeviceSampleContext {
  now: number;
  /** 第一阶段的精确合计；本 tick 没有任何来源贡献时为 null，设备样本不产生。 */
  appProcessTotals: AppResourceTotals | null;
  addDeviceSample: (sample: DeviceResourceSample) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

export interface ProcessResourceSampleSource {
  /** 来源标识，仅用于日志与注册表唯一性校验，不进入事件属性。 */
  readonly id: string;
  /**
   * main 每 10 秒 tick 调用，把本来源当前的瞬时事实写进当前窗口。
   *
   * push 型来源（host/scheduler heap、renderer heap、CLI、MCP）同样用这个钩子：
   * 各自导出一个 `ingestXxx(sample)` 供消息分发点调用，把最近一次样本存在来源模块内，
   * 然后在 `sample()` 里交给聚合器。这样窗口的切分权始终只在 main 的 flush 时钟上，
   * 来源之间不需要知道彼此，注册表也只加一行。
   */
  sample?: (context: ProcessResourceSampleContext) => void;
  /**
   * 需要「同一 tick 内其他来源已采到的事实」的来源用这个钩子（`perf_system_window`）。
   * 同一 tick 内先跑完全部 `sample`，再跑全部 `sampleDevice`。
   */
  sampleDevice?: (context: ProcessResourceDeviceSampleContext) => void;
  /**
   * 正常退出排空残窗时调用：把「已经收到、但还没赶上自己交付节拍」的读数补交给窗口
   * （CLI，MCP 同理）。**只搬已有事实，不做新采样**——退出路径不允许再读
   * `getAppMetrics()` 或起任何探针。
   */
  flushPending?: (context: ProcessResourceSampleContext) => void;
  /** 采样停止或重启时清空来源自身缓存的瞬时状态，避免跨 session 串数据。 */
  reset?: () => void;
}

export function runProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sample?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function runProcessResourceDeviceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceDeviceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sampleDevice?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function flushPendingProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.flushPending?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function resetProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
): void {
  for (const source of sources) {
    try {
      source.reset?.();
    } catch {
      // reset 只负责丢弃瞬时状态，失败不影响其他来源与后续采样。
    }
  }
}
