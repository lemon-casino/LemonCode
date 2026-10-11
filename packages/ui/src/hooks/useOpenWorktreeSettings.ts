import { useCallback } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  useWorktreeSettingsNavigation,
  type WorktreeSettingsTarget,
} from "@/store/worktreeSidebarStore.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";

export function useOpenWorktreeSettings() {
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  return useCallback(
    (target: WorktreeSettingsTarget, section: "worktrees" | "environments" = "worktrees") => {
      useWorktreeSettingsNavigation.getState().select(target);
      setPendingSettingsSection(section);
      openSettingsTab();
    },
    [openSettingsTab],
  );
}
