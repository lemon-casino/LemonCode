import { create } from "zustand";

/** 仅广播当前窗口的读取失效版本；工作树及归档事实仍由服务所有。 */
export const useWorktreeLifecycleStore = create<{
  revisions: Record<string, number>;
  invalidate(workspacePath: string, workspaceIdentity?: string): void;
}>((set) => ({
  revisions: {},
  invalidate: (workspacePath, workspaceIdentity) =>
    set((state) => {
      const scope = workspaceIdentity?.trim() || workspacePath;
      return { revisions: { ...state.revisions, [scope]: (state.revisions[scope] ?? 0) + 1 } };
    }),
}));
