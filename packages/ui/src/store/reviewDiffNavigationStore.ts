import { create } from "zustand";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

type OpenPreview = (source: CodeViewerSource) => void;
export interface ReviewFileActions {
  disabled: boolean;
  excludedFiles: readonly string[];
  exclude(paths: string[]): void;
  restore(paths: string[]): void;
}
export interface ReviewReturnEntry {
  reopen: () => void;
  files?: () => ReviewFileActions;
}

/** 仅保存窗口内临时导航；审核快照和合并事实仍由各自控制器及服务所有。 */
export const useReviewDiffNavigationStore = create<{
  openPreview: OpenPreview | null;
  returns: Record<string, ReviewReturnEntry>;
  registerPreview(open: OpenPreview): () => void;
  registerReturn(token: string, entry: ReviewReturnEntry): void;
  removeReturn(token: string): void;
}>((set, get) => ({
  openPreview: null,
  returns: {},
  registerPreview: (open) => {
    set({ openPreview: open });
    return () => {
      if (get().openPreview === open) set({ openPreview: null });
    };
  },
  registerReturn: (token, entry) =>
    set((state) => ({ returns: { ...state.returns, [token]: entry } })),
  removeReturn: (token) =>
    set((state) => {
      if (!(token in state.returns)) return state;
      const returns = { ...state.returns };
      delete returns[token];
      return { returns };
    }),
}));
