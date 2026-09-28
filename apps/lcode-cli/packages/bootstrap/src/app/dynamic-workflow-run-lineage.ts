// ============================================================
// Dynamic Workflow Run 的 lineage 读面（观察面的一小片）
// ============================================================
// 修订链两端的指针：`resumedFrom` 指向前驱，
// `supersededBy` 指向把自己停掉的后继。快照、列表、详情三个截面都要带这两个键，规则只写一遍。
// 从 dynamic-workflow-run-observation.ts 拆出是因为那份文件已顶到 oxlint 的 400 行上限。

import type { RunStatus } from "@lcode/dynamic-workflow";

/** 只看得到 lineage 所需两键的终态视图：注册表条目的 `terminal` 与 journal 行都满足它。 */
interface SupersedableSettlement {
  status: RunStatus;
  supersededBy?: string;
}

/**
 * 后继指针：内存终态优先，其次 journal 行；只对 stopped(superseded) 有意义——其余状态上即便
 * 载荷带着这个键（不应发生），也读作缺席，免得一条 completed 的 run 被画成「已被替代」。
 */
export function supersededByOf(
  entry: { terminal?: SupersedableSettlement } | undefined,
  record: { status?: RunStatus; supersededBy?: string } | undefined,
): string | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.supersededBy : undefined;
  }
  return record?.status === "stopped" ? record.supersededBy : undefined;
}

/** 两个指针在场才出现（缺席读作「没有这一端」，而 `undefined` 值会让每一行都带噪音键）。 */
export function lineageFields(
  resumedFrom: string | undefined,
  supersededBy: string | undefined,
): { resumedFrom?: string; supersededBy?: string } {
  return {
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}
