import type { SessionId } from "@lcode/contracts";
import { lcodeSessionWorktreeCleanupParamsSchema } from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

/** 不恢复聊天、不调用模型；永久删除由 SessionStore 的绑定校验事务执行。 */
export async function cleanupWorktreeSessions(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(lcodeSessionWorktreeCleanupParamsSchema, rawParams);
  const store = context.deps.sessionStore;
  if (!store?.worktreeCleanup)
    throw new Error("Agent does not support permanent worktree chat cleanup");
  const matching = await store.worktreeCleanup({
    ...params,
    sessionIds: undefined,
    seedSessionIds: params.seedSessionIds ?? params.sessionIds,
  });
  if (params.sessionIds === undefined && !params.closeSessions) return matching;
  const ids = params.sessionIds ?? matching.sessionIds;
  const allowed = new Set(matching.sessionIds);
  // 先校验全部存在记录，禁止范围错误时关闭另一个会话；SQL owner 随后再次事务校验。
  for (const id of ids) {
    if (!allowed.has(id) && (await store.getSession(id as SessionId)))
      throw new Error("Session is outside the confirmed worktree cleanup scope");
    const record = context.sessions.get(id);
    if (
      record &&
      (record.activeAbortController ||
        record.residencyFinalizationCount ||
        record.app.runtime.hasResidencyBlockingWork() ||
        context.v4Interactions.hasPendingForSession(id) ||
        context.v4Gateway?.hasResidencyBlockingCommands(id))
    )
      throw new Error("Worktree session is running; stop it before deleting");
  }
  for (const id of ids) {
    const record = context.sessions.get(id);
    if (!record) continue;
    record.unsubscribe?.();
    await record.app.close?.();
    context.v4Gateway?.disposeSession(id);
    context.sessions.delete(id);
    await record.eventStore.deleteSession(id as SessionId);
  }
  if (params.sessionIds === undefined) return matching;
  const deleted = await store.worktreeCleanup(params);
  // 正文事务已完成也不能提前返回成功：rollout/debug 仍含聊天内容且占空间，必须按原 IDs 清理。
  await context.deps.deleteSessionDiagnostics?.(deleted.sessionIds);
  return deleted;
}
