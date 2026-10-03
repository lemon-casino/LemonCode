import { resolveProjectExecutionPolicy } from "@lcode/shared";
import { useSettings } from "./useSettingService.js";

export function useProjectExecutionPolicy(
  workspacePath: string,
  workspaceIdentity?: string,
  mode?: "local" | "worktree",
) {
  const settings = useSettings();
  return {
    ...settings,
    policy: resolveProjectExecutionPolicy(
      settings.settings ?? {},
      { workspacePath, workspaceIdentity },
      mode,
    ),
  };
}
