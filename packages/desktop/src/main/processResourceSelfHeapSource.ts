/**
 * host 与 scheduler 自采 heap 的样本来源（注册表第三行）。
 *
 * 两个 utilityProcess 各自每 60 秒读一次 `process.memoryUsage()` 与 `process.cpuUsage()`，
 * 经 parentPort 把样本送到 main，由消息分发点调用这里的 `ingestXxx` 存下最近一次读数；
 * 下一个 10 秒 tick 把它并进同角色的完整样本，成为 `heap_used_kb_mean` / `heap_used_kb_peak`。
 *
 * 只取 heap：CPU 与 RSS 的唯一来源是 main 的 `getAppMetrics()`（角色定义表），
 * 把 60 秒口径的自采读数混进 10 秒序列会污染 `sample_count` 与统计量。
 * 每次读数只贡献一个 heap 样本（交付即清空），不拿旧值充当当前事实。
 */

import { nodeSelfResourceSampleSchema, type ProcessResourceRole } from "@lcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

/** 角色 → 尚未交付的 heap 读数（KB）。 */
const pendingHeapUsedKb = new Map<ProcessResourceRole, number>();

/**
 * 摄入口按 `unknown` 收：host 走 host 响应 schema、scheduler 走 main 里没有统一校验的私有协议，
 * 两条传输链路在这里合成同一个信任边界，校验只有这一处。
 * 非法消息（字段缺失、类型错误、夹带多余字段）直接丢弃，不抛错。
 */
function ingest(role: ProcessResourceRole, raw: unknown): void {
  const parsed = nodeSelfResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  // 多窗口 Host 会在同一 tick 到达；后到的小堆不能覆盖先到的峰值。
  pendingHeapUsedKb.set(role, Math.max(pendingHeapUsedKb.get(role) ?? 0, parsed.data.heapUsedKb));
}

export function ingestHostSelfResourceSample(raw: unknown): void {
  ingest("host", raw);
}

export function ingestSchedulerSelfResourceSample(raw: unknown): void {
  ingest("scheduler", raw);
}

export const selfHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "self_heap",
  sample(context) {
    // 先取走再投递：投递抛错也不会把旧读数留到下一个 tick。
    const delivering = [...pendingHeapUsedKb];
    pendingHeapUsedKb.clear();
    for (const [role, heapUsedKb] of delivering) {
      context.addRoleHeapSample(role, heapUsedKb);
    }
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
