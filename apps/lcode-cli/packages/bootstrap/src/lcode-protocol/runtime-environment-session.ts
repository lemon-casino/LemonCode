import {
  lcodeProtocolMethods,
  runtimeEnvironmentRetainSessionResultSchema,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

/** 会话持久引用与运行进程引用分开；关闭 app 不能释放这里的引用。 */
export async function retainRuntimeEnvironmentSession(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
  workspace: LCodeWorkspaceRef,
  sessionId: string,
): Promise<void> {
  if (!workspace.environmentRef) return;
  if (!workspace.executionBindingId)
    throw new Error("Managed session has no worktree binding");
  await context.requestClient(
    lcodeProtocolMethods.runtimeEnvironmentRetainSession,
    {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
      executionBindingId: workspace.executionBindingId,
      sessionId,
      environmentRef: workspace.environmentRef,
    },
    runtimeEnvironmentRetainSessionResultSchema,
  );
}
