import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import {
  BASH_RESOURCE_MAX_SAMPLES,
  BASH_RESOURCE_SAMPLE_INTERVAL_MS,
  type LCodeToolExecResource,
} from "@lcode/shared";
import { createProcessProbe, type ProcessProbe } from "../device/process-probe.js";

import { subscribeBashOutputProgress } from "./bash-progress-poller.js";
import { DEFAULT_PROGRESS_INTERVAL_MS } from "./execution-utils.js";

const BYTES_PER_KB = 1024;

interface BashResourceTelemetryOptions {
  processGroupId?: number;
  platform?: NodeJS.Platform;
  probe?: Pick<ProcessProbe, "sampleProcessGroup">;
  onComplete: (sample: LCodeToolExecResource) => void;
  readContext?: () => Pick<LCodeToolExecResource, "cliRssKb" | "systemFreeMemoryKb">;
}

/** 每条命令独占状态与探针失败预算；finish 同步封口，绝不等待遥测 IO。 */
export function createBashResourceTelemetry(options: BashResourceTelemetryOptions): {
  finish(exitKind: LCodeToolExecResource["exitKind"]): void;
} {
  const platform = options.platform ?? process.platform;
  const startedAt = performance.now();
  const probe = options.probe ?? createProcessProbe({ platform });
  const cpuByPid = new Map<number, number>();
  let finished = false;
  let lastSampleElapsedMs = 0;
  let attempts = 0;
  let sampleCount = 0;
  let treeRssKbPeak = 0;
  let treeCpuTimeMs = 0;
  let unsubscribe: (() => void) | undefined;

  const sample = async () => {
    const elapsedMs = performance.now() - startedAt;
    if (finished || elapsedMs - lastSampleElapsedMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
    lastSampleElapsedMs = elapsedMs;
    attempts += 1;
    try {
      const rows = await probe.sampleProcessGroup(options.processGroupId!);
      // 根退出时已封口；不能让迟到的 /proc 或 ps 结果修改已发送的摘要。
      if (finished || !rows?.length) return;
      sampleCount += 1;
      let rssKb = 0;
      for (const row of rows) {
        rssKb += row.rssKb;
        if (row.cpuTimeMs === undefined) continue;
        const previous = cpuByPid.get(row.pid) ?? 0;
        treeCpuTimeMs += Math.max(0, row.cpuTimeMs - previous);
        cpuByPid.set(row.pid, row.cpuTimeMs);
      }
      treeRssKbPeak = Math.max(treeRssKbPeak, rssKb);
    } catch {
      // 遥测失败只丢当前样本，不能改变 Bash 的退出、输出与超时行为。
    } finally {
      if (attempts === BASH_RESOURCE_MAX_SAMPLES) unsubscribe?.();
    }
  };
  if (platform !== "win32" && options.processGroupId !== undefined) {
    // 复用 Bash 已有的一秒共享轮询；按命令起点门控，错相位至多延后一轮，绝不提前采样。
    unsubscribe = subscribeBashOutputProgress(DEFAULT_PROGRESS_INTERVAL_MS, sample);
  }

  return {
    finish(exitKind) {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      cpuByPid.clear();
      const durationMs = performance.now() - startedAt;
      if (durationMs < BASH_RESOURCE_SAMPLE_INTERVAL_MS) return;
      try {
        const context = options.readContext?.() ?? {
          cliRssKb: process.memoryUsage.rss() / BYTES_PER_KB,
          systemFreeMemoryKb: freemem() / BYTES_PER_KB,
        };
        options.onComplete({
          // 多连接和多窗口可能重复转发同一事实；在命令封口后只生成一次，供 main 按身份去重。
          completionToken: randomUUID(),
          platform,
          toolName: "bash",
          durationMs,
          exitKind,
          sampleCount,
          ...context,
          ...(platform === "win32" ? {} : { treeRssKbPeak, treeCpuTimeMs }),
        });
      } catch {
        // IPC 已关闭或上下文读取失败时只丢通知，不影响命令结果。
      }
    },
  };
}
