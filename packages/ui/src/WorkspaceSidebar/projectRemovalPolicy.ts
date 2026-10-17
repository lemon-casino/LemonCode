export type ProjectRemovalBlockedReason =
  | "activeExecutionSet"
  | "dependentChats"
  | "activeBinding"
  | "verifySource";

/** 仅派生当前项目的入口移除权限，不能把来源失联误当作删除远端数据的授权。 */
export function projectRemovalBlockedReason(facts: {
  hasExecutionSets: boolean;
  hasIndependentChats: boolean;
  hasWorktrees: boolean;
  isRemote: boolean;
  sourceConnected: boolean;
  sourceLoading: boolean;
  sourceUnavailable: boolean;
}): ProjectRemovalBlockedReason | undefined {
  if (facts.hasExecutionSets) return "activeExecutionSet";
  if (facts.hasIndependentChats) return "dependentChats";
  if (facts.hasWorktrees) return "activeBinding";
  // 修复：失联占位没有可校验的来源，不能要求先连成功才能关闭；已知依赖仍由上面的事实保护。
  if (facts.isRemote && !facts.sourceConnected) return undefined;
  if (facts.sourceLoading || facts.sourceUnavailable) return "verifySource";
  return undefined;
}
