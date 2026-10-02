import { useCallback, useReducer, useRef } from "react";
import type { CommitMessageDraft } from "../git-action-menu/commitDraft.js";

const EMPTY_DRAFT: CommitMessageDraft = Object.freeze({
  message: "",
  previousMessage: null,
  edited: false,
  requiresRegeneration: false,
});

/** GitActionMenu 的局部草稿；只在本控制器生命周期保留，不持久化审核、确认或执行事实。 */
export function useGitCommitDraft(scope: string) {
  const drafts = useRef(new Map<string, CommitMessageDraft>());
  const [, redraw] = useReducer((revision: number) => revision + 1, 0);
  const read = useCallback(() => drafts.current.get(scope) ?? EMPTY_DRAFT, [scope]);
  const update = useCallback(
    (next: CommitMessageDraft) => {
      drafts.current.set(scope, next);
      redraw();
    },
    [scope],
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
