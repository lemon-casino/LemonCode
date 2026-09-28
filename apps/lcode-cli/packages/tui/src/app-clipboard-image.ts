import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { isValidClipboardImage } from "./app-input.js";
import type { PromptInputEditor } from "./app-input-pane.js";
import type { DraftAttachment } from "./app-model.js";
import type { TuiOptions } from "./types.js";

type UseClipboardImagePasteOptions = {
  abortControllerRef: MutableRefObject<AbortController | undefined>;
  busy: boolean;
  getDraftValue: () => string;
  inputEditorRef: MutableRefObject<PromptInputEditor | null>;
  nextAttachmentIdRef: MutableRefObject<number>;
  options: TuiOptions;
  setDraftAttachments: Dispatch<SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setStatus: Dispatch<SetStateAction<string>>;
  setStatusDetails: Dispatch<SetStateAction<string[]>>;
};

export function useClipboardImagePaste({
  abortControllerRef,
  busy,
  getDraftValue,
  inputEditorRef,
  nextAttachmentIdRef,
  options,
  setDraftAttachments,
  setDraftValue,
  setStatus,
  setStatusDetails,
}: UseClipboardImagePasteOptions): () => Promise<void> {
  return useCallback(async () => {
    if (busy) {
      setStatus("Image paste is available when the prompt is idle.");
      return;
    }
    if (!options.readClipboardImage) {
      setStatus("Image paste is not available in this terminal.");
      return;
    }

    try {
      setStatus("Reading image from clipboard...");
      const image = await options.readClipboardImage({
        abortSignal: abortControllerRef.current?.signal,
      });
      if (!image) {
        setStatus("No image found in clipboard.");
        return;
      }
      if (!isValidClipboardImage(image)) {
        setStatus("Clipboard image is not a supported image format.");
        return;
      }

      const id = nextAttachmentIdRef.current++;
      const placeholder = `[image #${id}]`;
      const attachment: DraftAttachment = {
        dataUrl: image.dataUrl,
        id,
        mediaType: image.mediaType,
        placeholder,
        sizeBytes: image.sizeBytes,
        type: "image",
      };
      setDraftAttachments((current) => [...current, attachment]);
      if (!insertPlaceholderIntoEditor(inputEditorRef.current, placeholder)) {
        setDraftValue(appendedImagePlaceholder(getDraftValue(), placeholder));
      }
      setStatus(`Attached ${placeholder}.`);
    } catch (error) {
      setStatus("Could not read image from clipboard.");
      setStatusDetails([error instanceof Error ? error.message : String(error)]);
    }
  }, [
    abortControllerRef,
    busy,
    getDraftValue,
    inputEditorRef,
    nextAttachmentIdRef,
    options,
    setDraftAttachments,
    setDraftValue,
    setStatus,
    setStatusDetails,
  ]);
}

function appendedImagePlaceholder(draft: string, placeholder: string): string {
  const trimmed = draft.trimEnd();
  return trimmed ? `${trimmed} ${placeholder}` : placeholder;
}

function insertPlaceholderIntoEditor(
  editor: PromptInputEditor | null,
  placeholder: string,
): boolean {
  if (!editor) return false;
  editor.setText(appendedImagePlaceholder(editor.plainText, placeholder));
  editor.gotoBufferEnd();
  return true;
}
