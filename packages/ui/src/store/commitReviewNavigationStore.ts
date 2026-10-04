import { create } from "zustand";

export function commitReviewNavigationKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string,
) {
  return JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
}

interface NavigationRequest {
  key: string;
  token: string;
}
interface CommitReviewNavigationState {
  draftReceivers: Record<string, { token: string; action: (text: string) => boolean | void }>;
  registerDraftReceiver: (
    key: string,
    receiver: { token: string; action: (text: string) => boolean | void },
  ) => void;
  removeDraftReceiver: (key: string, token: string) => void;
  transferDraft: (key: string, text: string) => boolean;
  resolvers: Record<string, { token: string; action: (operationId: string) => Promise<void> }>;
  registerResolver: (
    key: string,
    resolver: { token: string; action: (operationId: string) => Promise<void> },
  ) => void;
  removeResolver: (key: string, token: string) => void;
  request: NavigationRequest | null;
  open: (key: string) => void;
  consume: (key: string) => boolean;
  cancel: () => void;
}

// 只保存窗口内尚未消费的“打开界面”意图，不能作为提交、合并或人工审批事实。
export const useCommitReviewNavigationStore = create<CommitReviewNavigationState>((set, get) => ({
  draftReceivers: {},
  registerDraftReceiver: (key, receiver) =>
    set((state) => ({ draftReceivers: { ...state.draftReceivers, [key]: receiver } })),
  removeDraftReceiver: (key, token) => {
    if (get().draftReceivers[key]?.token !== token) return;
    const { [key]: removed, ...draftReceivers } = get().draftReceivers;
    void removed;
    set({ draftReceivers });
  },
  transferDraft: (key, text) => {
    const receiver = get().draftReceivers[key];
    if (!receiver) return false;
    return receiver.action(text) !== false;
  },
  resolvers: {},
  registerResolver: (key, resolver) =>
    set((state) => ({ resolvers: { ...state.resolvers, [key]: resolver } })),
  removeResolver: (key, token) => {
    if (get().resolvers[key]?.token !== token) return;
    const { [key]: removed, ...resolvers } = get().resolvers;
    void removed;
    set({ resolvers });
  },
  request: null,
  open: (key) => set({ request: { key, token: crypto.randomUUID() } }),
  consume: (key) => {
    if (get().request?.key !== key) return false;
    set({ request: null });
    return true;
  },
  cancel: () => set({ request: null }),
}));
