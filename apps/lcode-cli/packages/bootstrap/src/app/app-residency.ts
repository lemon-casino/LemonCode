import type { AgentRuntime } from "@lcode/core";

export interface AppResidencySnapshot {
  hasResidencyBlockingWork: boolean;
  liveRunCount: number;
  pendingCleanupCount: number;
}

/** 事实从唯一 owner 读取，不复制工作流运行表或另外维护一个保活计数。 */
export function readAppResidencySnapshot(
  runtime: Pick<AgentRuntime, "hasResidencyBlockingWork">,
  workflow?: { readResidencySnapshot(): { liveRunCount: number; pendingCleanupCount: number } },
): AppResidencySnapshot {
  const facts = workflow?.readResidencySnapshot() ?? { liveRunCount: 0, pendingCleanupCount: 0 };
  return {
    ...facts,
    hasResidencyBlockingWork:
      runtime.hasResidencyBlockingWork() || facts.liveRunCount > 0 || facts.pendingCleanupCount > 0,
  };
}
