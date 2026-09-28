// Coalesce 纯函数：CLI flush buffer 与黄金测试共用同一份规则。
// 语义要求：coalesce(deltas) 与逐条投递等价——这是「同一事件序列跑两个 profile 终态逐字节一致」
// 黄金测试成立的前提。任何合并都不得改变 apply 后的最终状态。
//
// 规则（封闭集合）：
//   1. 相邻同 (rowId, path) 的 row.delta → append 拼接；
//   2. 相邻 state.updated → patch 键浅合并（键内整体替换，安全）；
//   3. row.delta 后随同 rowId 的 row.upserted → 前者丢弃（整行替换蕴含所有追加）；
//   4. row.removed 是屏障，任何规则不得跨越；
//   5. 帧超限切分不在本函数（属通道层打帧）。
import type { ConversationDelta } from "./delta.js";

function isBarrier(delta: ConversationDelta): boolean {
  return delta.op === "row.removed";
}

/**
 * 对一个 flush 窗口内的 delta 序列做语义保持合并。
 * 输入输出均按权威日志序；纯函数，不修改入参。
 */
export function coalesceConversationDeltas(
  deltas: readonly ConversationDelta[],
): ConversationDelta[] {
  const result: ConversationDelta[] = [];

  for (const delta of deltas) {
    // 规则 3：row.upserted 吞掉同 rowId 更早的 row.delta。
    // 只回溯到最近的屏障（规则 4），且不越过同 rowId 的前一次 upserted/appended——
    // 越过会吞掉「上一代行」的追加，改变终态。
    if (delta.op === "row.upserted") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isBarrier(prev)) break;
        if (prev.op === "row.delta" && prev.rowId === delta.row.rowId) {
          result.splice(i, 1);
          continue;
        }
        if (
          (prev.op === "row.upserted" || prev.op === "row.appended") &&
          prev.row.rowId === delta.row.rowId
        ) {
          break;
        }
      }
    }

    const last = result[result.length - 1];

    // 规则 1：相邻同 (rowId, path) 的 row.delta 拼接。
    if (
      delta.op === "row.delta" &&
      last?.op === "row.delta" &&
      last.rowId === delta.rowId &&
      last.path === delta.path
    ) {
      result[result.length - 1] = {
        op: "row.delta",
        rowId: delta.rowId,
        path: delta.path,
        append: last.append + delta.append,
      };
      continue;
    }

    // 规则 2：相邻 state.updated 浅合并（后者的键覆盖前者；键内整体替换所以安全）。
    if (delta.op === "state.updated" && last?.op === "state.updated") {
      result[result.length - 1] = {
        op: "state.updated",
        patch: { ...last.patch, ...delta.patch },
      };
      continue;
    }

    // 相邻同 rowId 的 row.upserted：留最后一条（整行替换的传递性）。
    if (
      delta.op === "row.upserted" &&
      last?.op === "row.upserted" &&
      last.row.rowId === delta.row.rowId
    ) {
      result[result.length - 1] = delta;
      continue;
    }

    result.push(delta);
  }

  return result;
}

/**
 * conflation 辅助（sessions-index 等最新态 topic 通用）：按 key 只保留每个对象的最后一次更新。
 * 保序：保留项按其「最后一次出现」的相对顺序输出。
 */
export function conflateByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  return items.filter((item, index) => lastIndexByKey.get(keyOf(item)) === index);
}
