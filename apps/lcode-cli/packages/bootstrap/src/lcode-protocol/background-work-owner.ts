import type { SessionId, SessionInfo } from "@lcode/contracts";
import type { BackgroundBashOutputResult } from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

/** 只查询现存执行器，绝不为查看输出恢复 runtime。 */
export async function readBackgroundBashOutputFromOwner(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  workId: string,
): Promise<BackgroundBashOutputResult> {
  const visited = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const live = context.sessions.get(current);
    if (live) {
      // 冷恢复的 child record 可能使用新 adapter，旧任务仍在祖先中；不能把存活等同于持有任务。
      // 始终传原始 sessionId 校验归属，仅任务不存在时继续，读取失败或能力缺失原样返回。
      const result = await live.app.readBackgroundBashOutput(workId, sessionId);
      if (result.kind !== "unavailable") return result;
    }
    const stored: SessionInfo | null | undefined = await context.deps.sessionStore?.getSession(
      current as SessionId,
    );
    current = stored?.parentID ? String(stored.parentID) : undefined;
  }
  return { kind: "unavailable", workId };
}
