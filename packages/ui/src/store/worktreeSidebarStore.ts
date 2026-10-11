import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useWorktreeSidebarStore = create(
  persist<{
    collapsed: Record<string, boolean>;
    toggle(key: string): void;
  }>(
    (set) => ({
      collapsed: {},
      toggle: (key) =>
        set((state) => ({ collapsed: { ...state.collapsed, [key]: !state.collapsed[key] } })),
    }),
    {
      name: "lcode-worktree-sidebar",
      partialize: (state) => ({ ...state, collapsed: state.collapsed }),
    },
  ),
);

export interface WorktreeSettingsTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  bindingId?: string;
  sessionId?: string;
}
export const useWorktreeSettingsNavigation = create<{
  target: WorktreeSettingsTarget | null;
  select(target: WorktreeSettingsTarget): void;
}>((set) => ({ target: null, select: (target) => set({ target }) }));
