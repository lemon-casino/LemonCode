import type { BackgroundBashOutputResult } from "@lcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";

/** 执行记录按启动时 sessionId 验证归属，祖先 runtime 也不能读到其他会话的 workId。 */
export async function readBackgroundBashOutput(
  this: AgentRuntimeInternal,
  workId: string,
  sessionId = this.sessionId as string,
): Promise<BackgroundBashOutputResult> {
  if (!this.executionPort?.readBackgroundBashOutput) return { kind: "unsupported", workId };
  return this.executionPort.readBackgroundBashOutput(workId, sessionId);
}
