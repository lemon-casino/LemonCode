/**
 * LCode Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useLCodeSessionStore, selectWorkspaceLCodeState } from "../store/lcodeSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useLCodeSessionStore(
    (state) => selectWorkspaceLCodeState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
