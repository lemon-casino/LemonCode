import { create } from "zustand";
import type { CommandEnvelope } from "@lcode/shared/lcode-protocol-v4";

export interface DraftExecutionSelection {
  mode?: "local" | "worktree";
  baseRef?: string;
  requestId?: string;
  frozen?: boolean;
  retryRevision?: number;
  attachmentPreparation?: boolean;
  error?: string;
  creationEnvelope?: CommandEnvelope;
}

interface DraftExecutionStore {
  drafts: Record<string, DraftExecutionSelection>;
  choose(scope: string, selection: Pick<DraftExecutionSelection, "mode" | "baseRef">): void;
  begin(
    scope: string,
    requestId: string,
    attachmentPreparation?: boolean,
    intent?: Pick<DraftExecutionSelection, "mode" | "baseRef">,
    creationEnvelope?: CommandEnvelope,
  ): void;
  settle(scope: string, requestId: string, error?: string): void;
  retry(scope: string): void;
  reset(scope: string): void;
}

/** 仅拥有未提交意图及请求展示；实际 binding 由 CLI / WorktreeService 所有。 */
export const useDraftExecutionStore = create<DraftExecutionStore>((set) => ({
  drafts: {},
  choose: (scope, selection) =>
    set((state) =>
      state.drafts[scope]?.requestId || state.drafts[scope]?.frozen
        ? state
        : {
            drafts: {
              ...state.drafts,
              [scope]: { ...state.drafts[scope], ...selection, error: undefined },
            },
          },
    ),
  begin: (scope, requestId, attachmentPreparation, intent, creationEnvelope) =>
    set((state) => ({
      // 首次物化后固定已提交意图，避免全局设置更新将运行中任务显示为另一种执行方式。
      drafts: {
        ...state.drafts,
        [scope]: {
          ...state.drafts[scope],
          ...intent,
          requestId,
          frozen: true,
          creationEnvelope: creationEnvelope ?? state.drafts[scope]?.creationEnvelope,
          attachmentPreparation:
            attachmentPreparation || state.drafts[scope]?.attachmentPreparation,
          error: undefined,
        },
      },
    })),
  settle: (scope, requestId, error) =>
    set((state) => {
      if (state.drafts[scope]?.requestId !== requestId) return state;
      return {
        drafts: {
          ...state.drafts,
          [scope]: { ...state.drafts[scope], requestId: undefined, error },
        },
      };
    }),
  retry: (scope) =>
    set((state) => {
      const draft = state.drafts[scope];
      if (!draft?.error || draft.requestId) return state;
      return {
        drafts: {
          ...state.drafts,
          [scope]: { ...draft, retryRevision: (draft.retryRevision ?? 0) + 1 },
        },
      };
    }),
  reset: (scope) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[scope];
      return { drafts };
    }),
}));
