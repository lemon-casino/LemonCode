import React from "react";
import {
  filterEffortOptions,
  reconcileEffortCommandSelection,
  selectedEffortOption,
} from "./app-input.js";
import type { EffortCommandSelectionState } from "./app-model.js";
import type { TuiEffortOption } from "./types.js";

export function useEffortCommandController(
  draft: string,
  effortOptions: readonly TuiEffortOption[],
): {
  filteredOptions: readonly TuiEffortOption[];
  reconcileDraft: (value: string) => EffortCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiEffortOption | undefined;
  selection: EffortCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<EffortCommandSelectionState | undefined>>;
} {
  const [selection, setSelection] = React.useState<EffortCommandSelectionState | undefined>();
  const filteredOptions = React.useMemo(
    () => filterEffortOptions(draft, effortOptions),
    [draft, effortOptions],
  );
  const reconcileDraft = React.useCallback(
    (value: string) => {
      const nextSelection = reconcileEffortCommandSelection(value, effortOptions);
      setSelection(nextSelection);
      return nextSelection;
    },
    [effortOptions],
  );
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedEffortOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
  };
}
