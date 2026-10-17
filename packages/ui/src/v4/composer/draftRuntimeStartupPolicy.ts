import { isRemoteWorkspaceIdentity } from "@lcode/shared";

/** 远端空白草稿只读取 Host 模型目录；首次发送/打开历史才允许启动执行进程。 */
export function shouldDeferDraftRuntime(
  sessionId: string | null,
  workspaceIdentity?: string,
): boolean {
  return (
    sessionId === null && Boolean(workspaceIdentity && isRemoteWorkspaceIdentity(workspaceIdentity))
  );
}
