import type { SessionId } from "@lcode/contracts";
import {
  lcodeSessionWorktreeRebindParamsSchema,
  type LCodeSessionWorktreeRebindParams,
  type LCodeWorkspaceRef,
  type RuntimeEnvironmentReference,
} from "@lcode/shared";
import { parseParams, type LCodeProtocolAgentServerContext } from "./server-types.js";

const identityKey = (path: string, identity?: string) => identity?.trim() || path;
function matchesReference(
  reference: LCodeWorkspaceRef["environmentRef"],
  expected: RuntimeEnvironmentReference,
) {
  return (
    reference?.environmentId === expected.environmentId &&
    reference.revision === expected.revision &&
    reference.manifestDigest === expected.manifestDigest
  );
}
function assertResidentScope(
  workspace: LCodeWorkspaceRef,
  params: LCodeSessionWorktreeRebindParams,
) {
  if (
    workspace.executionBindingId !== params.executionBindingId ||
    workspace.originWorkspacePath !== params.originWorkspacePath ||
    identityKey(workspace.originWorkspacePath, workspace.originWorkspaceIdentity) !==
      identityKey(params.originWorkspacePath, params.originWorkspaceIdentity) ||
    workspace.workspacePath !== params.workspacePath ||
    identityKey(workspace.workspacePath, workspace.workspaceIdentity) !==
      identityKey(params.workspacePath, params.workspaceIdentity) ||
    workspace.workspaceKey !== identityKey(params.workspacePath, params.workspaceIdentity)
  )
    throw new Error("Resident session is outside the confirmed worktree rebind scope");
  if (
    !matchesReference(workspace.environmentRef, params.oldEnvironmentRef) &&
    !matchesReference(workspace.environmentRef, params.newEnvironmentRef)
  )
    throw new Error("Resident worktree environment reference mismatch");
}

/** 受信维护：不创建 app，不恢复 transcript，不调用模型；SessionStore 是唯一持久写入者。 */
export async function rebindWorktreeSessions(
  context: LCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(lcodeSessionWorktreeRebindParamsSchema, rawParams);
  const store = context.deps.sessionStore;
  if (!store?.worktreeRebind) throw new Error("Agent does not support worktree environment rebind");
  const { sessionIds } = await store.worktreeRebind(params);
  const maintain = async () => {
    const residents = sessionIds.flatMap((id) => {
      const record = context.sessions.get(id);
      if (!record) return [];
      assertResidentScope(record.workspace, params);
      if (
        record.activeAbortController ||
        record.residencyFinalizationCount ||
        record.app.runtime.hasResidencyBlockingWork() ||
        context.v4Interactions.hasPendingForSession(id) ||
        context.v4Gateway?.hasResidencyBlockingCommands(id)
      )
        throw new Error("Worktree session is running; stop it before rebinding");
      context.v4Gateway?.assertSessionRuntimeDeactivatable(id);
      return [{ id, record }];
    });
    // 先全量预检，再同步摘除全部旧 record；gate 持有到 CAS 完成，冷恢复不能抓到旧环境引用。
    for (const { id, record } of residents) {
      record.unsubscribe?.();
      context.v4Gateway?.deactivateSession(id);
      context.sessions.delete(id);
    }
    for (const { id, record } of residents) {
      await record.app.close?.();
      await record.eventStore.deleteSession(id as SessionId);
    }
    return store.worktreeRebind!({ ...params, expectedSessionIds: sessionIds });
  };
  return context.sessionResidentPool
    ? context.sessionResidentPool.withMaintenance(sessionIds, maintain)
    : maintain();
}
