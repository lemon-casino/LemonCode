import type { TuiCopy } from "@lcode/i18n";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toDraftAttachments } from "./app-input.js";
import type { DraftAttachment, SlashSelectionState } from "./app-model.js";
import type { TuiOptions, TuiPromptAttachment } from "./types.js";

type UseInputHistoryOptions = {
  copy: TuiCopy;
  draftAttachmentsRef: MutableRefObject<DraftAttachment[]>;
  draftRef: MutableRefObject<string>;
  inputHistoryDraftAttachmentsRef: MutableRefObject<DraftAttachment[] | undefined>;
  inputHistoryDraftRef: MutableRefObject<string | undefined>;
  inputHistoryIndexRef: MutableRefObject<number>;
  nextAttachmentIdRef: MutableRefObject<number>;
  options: TuiOptions;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftState: Dispatch<SetStateAction<string>>;
  setDraftValue: (value: string) => void;
  setInputCursorToEndVersion: Dispatch<SetStateAction<number>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  setStatus: Dispatch<SetStateAction<string>>;
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

export function useInputHistory({
  copy,
  draftAttachmentsRef,
  draftRef,
  inputHistoryDraftAttachmentsRef,
  inputHistoryDraftRef,
  inputHistoryIndexRef,
  nextAttachmentIdRef,
  options,
  setDraftAttachments,
  setDraftState,
  setDraftValue,
  setInputCursorToEndVersion,
  setSlashSelection,
  setStatus,
  setStatusDetails,
}: UseInputHistoryOptions): {
  recallNextInput: () => Promise<void>;
  recallPreviousInput: () => Promise<void>;
} {
  const restoreHistoryDraft = useCallback(
    (value: string, attachments?: TuiPromptAttachment[]) => {
      const restoredAttachments = toDraftAttachments(
        attachments,
        () => nextAttachmentIdRef.current++,
      );
      for (const attachment of restoredAttachments) {
        nextAttachmentIdRef.current = Math.max(nextAttachmentIdRef.current, attachment.id + 1);
      }
      draftRef.current = value;
      setDraftState(value);
      setDraftAttachments(restoredAttachments);
      setSlashSelection(undefined);
      setInputCursorToEndVersion((current) => current + 1);
    },
    [
      draftRef,
      nextAttachmentIdRef,
      setDraftAttachments,
      setDraftState,
      setInputCursorToEndVersion,
      setSlashSelection,
    ],
  );

  const recallPreviousInput = useCallback(async () => {
    if (!options.recallPreviousInput) {
      setStatus(copy.input.noHistorySource);
      return;
    }
    if (inputHistoryDraftRef.current === undefined) {
      inputHistoryDraftRef.current = draftRef.current;
      inputHistoryDraftAttachmentsRef.current = draftAttachmentsRef.current;
    }
    try {
      const skip = inputHistoryIndexRef.current;
      const previous = await options.recallPreviousInput(skip);
      if (!previous?.text) {
        setStatus(copy.input.noPreviousInput);
        return;
      }
      inputHistoryIndexRef.current = skip + 1;
      restoreHistoryDraft(previous.text, previous.attachments);
      setStatus(
        previous.attachments?.length
          ? copy.input.restoredPreviousInputWithAttachments(previous.attachments.length)
          : copy.input.restoredPreviousInput,
      );
    } catch (error) {
      setStatus(copy.input.restorePreviousInputFailed);
      setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }, [
    copy,
    draftAttachmentsRef,
    draftRef,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    options,
    restoreHistoryDraft,
    setStatus,
    setStatusDetails,
  ]);

  const recallNextInput = useCallback(async () => {
    if (inputHistoryDraftRef.current === undefined) return;
    if (inputHistoryIndexRef.current <= 1) {
      setDraftValue(inputHistoryDraftRef.current);
      setDraftAttachments(inputHistoryDraftAttachmentsRef.current ?? []);
      setInputCursorToEndVersion((current) => current + 1);
      inputHistoryDraftAttachmentsRef.current = undefined;
      inputHistoryDraftRef.current = undefined;
      inputHistoryIndexRef.current = 0;
      setStatus(copy.status.ready);
      return;
    }

    inputHistoryIndexRef.current -= 1;
    try {
      const previous = await options.recallPreviousInput?.(inputHistoryIndexRef.current - 1);
      if (previous?.text) restoreHistoryDraft(previous.text, previous.attachments);
    } catch {
      // History navigation is best-effort.
    }
  }, [
    copy,
    inputHistoryDraftAttachmentsRef,
    inputHistoryDraftRef,
    inputHistoryIndexRef,
    options,
    restoreHistoryDraft,
    setDraftAttachments,
    setDraftValue,
    setInputCursorToEndVersion,
    setStatus,
  ]);

  return { recallNextInput, recallPreviousInput };
}
