import type { KeyEvent } from "@mbears/opentui-core";
import type React from "react";
import type { SelectionState, SubmitValueOptions } from "./app-model.js";
import { matchesText } from "./state.js";
import type { TuiSelectionItem } from "./types.js";

const DEFAULT_INPUT_CANCEL_STATUS = "Input cancelled.";
const DEFAULT_INPUT_EMPTY_STATUS = "Input is required.";
const DEFAULT_INPUT_CLEAR_STATUS = "Input cleared.";
const DEFAULT_PENDING_CANCEL_STATUS = "Selection cancelled.";
const DEFAULT_FILTER_CLEAR_STATUS = "Selection filter cleared.";
const INPUT_COMMAND_SEPARATOR = " ";
const MASK_CHAR = "*";
const MAX_MASK_WIDTH = 24;
const CONTROL_KEY_NAMES = new Set([
  "backspace",
  "delete",
  "down",
  "end",
  "escape",
  "home",
  "left",
  "pagedown",
  "pageup",
  "return",
  "right",
  "tab",
  "up",
]);

export function filterSelectionItems(selection: SelectionState): TuiSelectionItem[] {
  if (selection.filterable === false) return [...selection.items];
  return selection.items.filter((item) =>
    matchesText(selection.filter, [
      item.primary,
      item.secondary,
      item.meta,
      item.command,
      item.input?.primary,
      item.input?.secondary,
      ...(item.keywords ?? []),
    ]),
  );
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

// selectedIndex is global within the filtered rows, so the rendered
// slice must follow it instead of always drawing the first page.
export function visibleSelectionItemWindow(
  items: readonly TuiSelectionItem[],
  selectedIndex: number,
  maxVisible: number,
): {
  items: readonly TuiSelectionItem[];
  selectedIndex: number;
  startIndex: number;
} {
  if (items.length === 0 || maxVisible <= 0) {
    return {
      items: [],
      selectedIndex: 0,
      startIndex: 0,
    };
  }

  const clampedSelectedIndex = clampIndex(selectedIndex, items.length);
  const visibleCount = Math.min(maxVisible, items.length);
  const maxStartIndex = items.length - visibleCount;
  const startIndex = Math.min(
    Math.max(0, clampedSelectedIndex - visibleCount + 1),
    maxStartIndex,
  );

  return {
    items: items.slice(startIndex, startIndex + visibleCount),
    selectedIndex: clampedSelectedIndex - startIndex,
    startIndex,
  };
}

export function handleSelectionKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
  cancelPendingSelection?: () => void,
): void {
  if (selection.pending) {
    handlePendingSelectionKey(key, selection, setSelection, setStatus, cancelPendingSelection);
    return;
  }

  if (selection.input) {
    handleSelectionInputKey(key, selection, setSelection, setStatus, submitValue);
    return;
  }

  if (key.name === "escape") {
    setSelection(undefined);
    setStatus("Selection cancelled.");
    return;
  }

  const visible = filterSelectionItems(selection);
  if (key.name === "up") {
    setSelection((current) =>
      current
        ? { ...current, selectedIndex: clampIndex(current.selectedIndex - 1, visible.length) }
        : current,
    );
    return;
  }
  if (key.name === "down") {
    setSelection((current) =>
      current
        ? { ...current, selectedIndex: clampIndex(current.selectedIndex + 1, visible.length) }
        : current,
    );
    return;
  }
  if (key.name === "backspace") {
    if (selection.filterable === false) return;
    setSelection((current) =>
      current ? { ...current, filter: current.filter.slice(0, -1), selectedIndex: 0 } : current,
    );
    return;
  }
  if (key.name === "u" && key.ctrl) {
    if (selection.filterable === false) return;
    setSelection((current) => (current ? { ...current, filter: "", selectedIndex: 0 } : current));
    setStatus(DEFAULT_FILTER_CLEAR_STATUS);
    return;
  }
  if (key.name === "return") {
    submitSelectedItem(selection, visible, setSelection, setStatus, submitValue);
    return;
  }

  const character = printableKey(key);
  if (character && selection.filterable !== false) {
    setSelection((current) =>
      current ? { ...current, filter: `${current.filter}${character}`, selectedIndex: 0 } : current,
    );
  }
}

export function printableKey(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (key.name === "space") return " ";
  if (key.name.length === 1 && key.name >= " ") {
    return key.shift ? key.name.toUpperCase() : key.name;
  }
  if (key.sequence.length === 1 && key.sequence >= " ") return key.sequence;
  return undefined;
}

export function selectionInputDisplayValue(input: NonNullable<SelectionState["input"]>): string {
  if (!input.value) return input.placeholder ?? "";
  if (!input.mask) return input.value;
  const maskWidth = Math.min(input.value.length, MAX_MASK_WIDTH);
  const suffix = input.value.length > MAX_MASK_WIDTH ? "..." : "";
  return `${MASK_CHAR.repeat(maskWidth)}${suffix}`;
}

function handlePendingSelectionKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  cancelPendingSelection?: () => void,
): void {
  if (key.name !== "escape") return;
  cancelPendingSelection?.();
  const cancelStatus = selection.pending?.cancelStatus ?? DEFAULT_PENDING_CANCEL_STATUS;
  setSelection((current) => (current ? { ...current, pending: undefined } : current));
  setStatus(cancelStatus);
}

function handleSelectionInputKey(
  key: KeyEvent,
  selection: SelectionState,
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
): void {
  const input = selection.input;
  if (!input) return;

  if (key.name === "escape") {
    setSelection((current) => (current ? { ...current, input: undefined } : current));
    setStatus(input.cancelStatus ?? DEFAULT_INPUT_CANCEL_STATUS);
    return;
  }
  if (key.name === "return") {
    const value = input.value.trim();
    if (!value) {
      setStatus(input.emptyStatus ?? DEFAULT_INPUT_EMPTY_STATUS);
      return;
    }
    setSelection(undefined);
    setStatus(input.submitStatus ?? `Selected ${input.primary}.`);
    void submitValue(`${input.command}${INPUT_COMMAND_SEPARATOR}${value}`);
    return;
  }
  if (key.name === "backspace") {
    setSelection((current) =>
      current
        ? { ...current, input: { ...input, value: removeLastCharacter(input.value) } }
        : current,
    );
    return;
  }
  if (key.name === "u" && key.ctrl) {
    setSelection((current) => (current ? { ...current, input: { ...input, value: "" } } : current));
    setStatus(input.clearStatus ?? DEFAULT_INPUT_CLEAR_STATUS);
    return;
  }

  const text = printableInputText(key);
  if (!text) return;
  setSelection((current) =>
    current ? { ...current, input: { ...input, value: `${input.value}${text}` } } : current,
  );
}

function submitSelectedItem(
  selection: SelectionState,
  visible: TuiSelectionItem[],
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>,
  setStatus: (status: string) => void,
  submitValue: (value: string, options?: SubmitValueOptions) => Promise<void>,
): void {
  const item = visible[clampIndex(selection.selectedIndex, visible.length)];
  if (!item) {
    setStatus("No matching item to select.");
    return;
  }
  if (item.disabledReason) {
    setStatus(item.disabledReason);
    return;
  }
  const itemInput = item.input;
  if (itemInput) {
    const selectedIndex = clampIndex(selection.selectedIndex, visible.length);
    setSelection((current) =>
      current
        ? {
            ...current,
            filter: "",
            input: {
              ...itemInput,
              command: item.command,
              itemId: item.id,
              primary: itemInput.primary,
              value: "",
            },
            selectedIndex,
          }
        : current,
    );
    setStatus(itemInput.status ?? `Enter ${item.primary}.`);
    return;
  }
  const pending = item.pending;
  if (pending) {
    const selectedIndex = clampIndex(selection.selectedIndex, visible.length);
    setSelection((current) =>
      current
        ? {
            ...current,
            filter: "",
            pending: {
              ...pending,
              command: item.command,
              itemId: item.id,
            },
            selectedIndex,
          }
        : current,
    );
    setStatus(pending.status ?? `Selected ${item.primary}.`);
    void submitValue(item.command, {
      abortStatus: pending.cancelStatus,
      preserveSelection: true,
    });
    return;
  }
  setSelection(undefined);
  setStatus(`Selected ${item.primary}.`);
  void submitValue(item.command);
}

function printableInputText(key: KeyEvent): string | undefined {
  const character = printableKey(key);
  if (character) return character;
  if (key.ctrl || key.meta || CONTROL_KEY_NAMES.has(key.name)) return undefined;
  if (key.sequence.length === 0) return undefined;
  return [...key.sequence].every((char) => char >= " " && char !== "\x7f")
    ? key.sequence
    : undefined;
}

function removeLastCharacter(value: string): string {
  const characters = Array.from(value);
  characters.pop();
  return characters.join("");
}
