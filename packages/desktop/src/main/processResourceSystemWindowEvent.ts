/** `perf_system_window` 的属性投影（纯函数，属性 key 与白名单一一对应，共 17 个）。 */

import { PROCESS_RESOURCE_EVENT_NAMES } from "@lcode/shared";
import type { SystemResourceWindowReport } from "./processResourceSystemWindowAggregator.js";
import {
  normalizeOsCategory,
  type ProcessResourceReportContext,
} from "./processResourceWindowEvent.js";

export const PERF_SYSTEM_WINDOW_EVENT_NAME = PROCESS_RESOURCE_EVENT_NAMES.systemWindow;

/** 硬件维度描述桌面机本身：设备级事件只统计本机进程，没有远端覆盖的情形。 */
export function buildSystemWindowEventProperties(
  report: SystemResourceWindowReport,
  context: ProcessResourceReportContext,
): Record<string, string | number | undefined> {
  const hardware = context.desktopHardware;
  return {
    platform: normalizeOsCategory(hardware.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
    device_mid: context.deviceMid,
    arch: hardware.arch,
    logical_cpu_count: hardware.logicalCpuCount,
    total_memory_gb: hardware.totalMemoryGb,
    background_ratio: report.backgroundRatio,
    app_uptime_minutes: report.appUptimeMinutes,
    system_cpu_percent_p95: report.systemCpuPercentP95,
    system_free_memory_kb_min: report.systemFreeMemoryKbMin,
    app_cpu_percent_p95: report.appCpuPercentP95,
    app_rss_kb_total_mean: report.appRssKbTotalMean,
    app_rss_kb_total_peak: report.appRssKbTotalPeak,
    process_count_total_peak: report.processCountTotalPeak,
    sample_count: report.sampleCount,
    telemetry_self_ms: report.telemetrySelfMs,
  };
}
