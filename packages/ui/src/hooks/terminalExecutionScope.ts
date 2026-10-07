import type { ITerminalService } from "@lcode/services";

type TerminalCreateParams = Parameters<ITerminalService["create"]>[0];
/** 只读创建请求，不是环境/租约事实；实际 binding 和 frozen env 由 Host 校验。 */
export type TerminalExecutionScope = Pick<
  TerminalCreateParams,
  | "workspacePath"
  | "workspaceIdentity"
  | "sessionId"
  | "remoteSessionId"
  | "executionBindingId"
  | "environmentRef"
>;

export function createScopedTerminal(
  terminalService: ITerminalService,
  params: Pick<TerminalCreateParams, "cols" | "rows" | "cwd">,
  scope?: TerminalExecutionScope,
): ReturnType<ITerminalService["create"]> {
  // 显式白名单避免 UI 把旧 envOverlay/PATH 透传到 RPC，身份只用于 owner 对账。
  return terminalService.create({
    cols: params.cols,
    rows: params.rows,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(scope?.workspacePath ? { workspacePath: scope.workspacePath } : {}),
    ...(scope?.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope?.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
    ...(scope?.executionBindingId ? { executionBindingId: scope.executionBindingId } : {}),
    ...(scope?.environmentRef ? { environmentRef: scope.environmentRef } : {}),
  });
}
