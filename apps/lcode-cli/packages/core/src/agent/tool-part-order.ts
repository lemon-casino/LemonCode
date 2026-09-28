import type { ToolPart } from "@lcode/contracts";

export function selectToolPartsForHistory(parts: ToolPart[]): ToolPart[] {
  // 提前执行失败或断流恢复会另建 part；同一声明只恢复最后新建的记录，旧 part 迟到更新不影响选择。
  // 保留所选记录的物理顺序，原始 parts 仍供 UI 和文件读取状态恢复使用。
  const latestByCallId = new Map(parts.map((part) => [part.callID, part]));
  const latestParts = parts.filter((part) => latestByCallId.get(part.callID) === part);
  if (latestParts.some((part) => part.declarationIndex === undefined)) {
    // 旧记录或混合版本可能缺少声明序号，整组保留原序。
    return latestParts;
  }
  // 只读工具可能先落盘；provider calls/results 应共用声明顺序，不改 UI 的原始 parts。
  return latestParts.sort((left, right) => left.declarationIndex! - right.declarationIndex!);
}
