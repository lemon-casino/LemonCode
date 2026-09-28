import { clampIndex } from "./app-input.js";
import type { SelectionState } from "./app-model.js";
import type { TuiSelection } from "./types.js";

export function createSelectionState(
  selection: TuiSelection | undefined,
): SelectionState | undefined {
  if (!selection) return undefined;
  return {
    ...selection,
    filter: "",
    selectedIndex: clampIndex(selection.selectedIndex ?? 0, selection.items.length),
  };
}
