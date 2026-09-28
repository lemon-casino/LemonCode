import type { TuiWriteClipboardText } from "./types.js";
import type { TuiCopy } from "@lcode/i18n";

export type SelectionCopyResult =
  | {
      characterCount: number;
      kind: "copied";
    }
  | {
      kind: "empty";
    }
  | {
      kind: "unavailable";
    }
  | {
      kind: "failed";
      message: string;
    };

type SelectionCopyHandlerOptions = {
  clearSelection: () => void;
  getSelectionText: () => string | null | undefined;
  writeClipboardText?: TuiWriteClipboardText;
};

export function createSelectionCopyHandler({
  clearSelection,
  getSelectionText,
  writeClipboardText,
}: SelectionCopyHandlerOptions): () => Promise<SelectionCopyResult> {
  return async () => {
    const text = getSelectionText();
    if (!hasCopyableSelectionText(text)) {
      clearSelection();
      return { kind: "empty" };
    }
    if (!writeClipboardText) {
      clearSelection();
      return { kind: "unavailable" };
    }

    try {
      await writeClipboardText(text);
      return {
        characterCount: text.length,
        kind: "copied",
      };
    } catch (error) {
      return {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearSelection();
    }
  };
}

export function hasCopyableSelectionText(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim().length > 0;
}

export function selectionCopyStatus(
  result: SelectionCopyResult,
  copy: TuiCopy["copy"],
): {
  details?: string[];
  status?: string;
} {
  if (result.kind === "copied") {
    return {
      details: [],
      status: copy.copied,
    };
  }
  if (result.kind === "unavailable") {
    return {
      details: [],
      status: copy.unavailable,
    };
  }
  if (result.kind === "failed") {
    return {
      details: [result.message],
      status: copy.failed,
    };
  }
  return {};
}
