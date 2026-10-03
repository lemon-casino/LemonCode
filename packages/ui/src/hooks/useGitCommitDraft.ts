import { useCallback } from "react";
import type { CommitMessageDraft } from "../git-action-menu/commitDraft.js";
import type { useReviewWorkspaceState } from "./useReviewWorkspaceState.js";

const EMPTY_DRAFT: CommitMessageDraft = Object.freeze({
  message: "",
  previousMessage: null,
  edited: false,
  requiresRegeneration: false,
});

/** 草稿读写沿 Host 审核状态的唯一 admission，确认和执行事实仍由各自 owner 持有。 */
export function useGitCommitDraft(workspace: ReturnType<typeof useReviewWorkspaceState>) {
  const { read: readWorkspace, patch } = workspace;
  const read = useCallback(() => readWorkspace().data.draft, [readWorkspace]);
  const update = useCallback(
    (next: CommitMessageDraft) => {
      patch({ draft: next });
    },
    [patch],
  );
  const edit = useCallback(
    (message: string) => update({ ...read(), message, edited: true }),
    [read, update],
  );
  const generated = useCallback(
    (message: string) => {
      const previous = read();
      update({
        message,
        previousMessage: previous.message,
        edited: false,
        requiresRegeneration: false,
      });
    },
    [read, update],
  );
  const prefill = useCallback(
    (message: string) => {
      if (read().edited || read().message) return false;
      update({ ...EMPTY_DRAFT, message });
      return true;
    },
    [read, update],
  );
  const invalidate = useCallback(
    () => update({ ...read(), requiresRegeneration: true }),
    [read, update],
  );
  const regenerated = useCallback(
    () => update({ ...read(), requiresRegeneration: false }),
    [read, update],
  );
  const restore = useCallback(() => {
    const previous = read();
    if (previous.previousMessage !== null)
      update({
        ...previous,
        message: previous.previousMessage,
        previousMessage: null,
        edited: true,
      });
  }, [read, update]);
  const committed = useCallback(
    (nextMessage = "") => update({ ...EMPTY_DRAFT, message: nextMessage }),
    [update],
  );
  return {
    draft: read(),
    read,
    edit,
    generated,
    prefill,
    invalidate,
    regenerated,
    restore,
    committed,
  };
}
