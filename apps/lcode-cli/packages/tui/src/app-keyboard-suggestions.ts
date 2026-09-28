import type { KeyEvent } from "@mbears/opentui-core";
import type { Dispatch, SetStateAction } from "react";
import { clampIndex } from "./app-input.js";
import type {
  EffortCommandSelectionState,
  ModeCommandSelectionState,
  ModelCommandSelectionState,
  SlashCommand,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiEffortOption, TuiModeOption, TuiModelOption } from "./types.js";

type SelectionWithIndex = {
  selectedIndex: number;
};

type NavigationDelta = -1 | 1;

type SuggestionNavigationInput = {
  consumeKey: (key: KeyEvent) => void;
  effortSelection: EffortCommandSelectionState | undefined;
  filteredEffortOptions: readonly TuiEffortOption[];
  filteredModeOptions: readonly TuiModeOption[];
  filteredModelOptions: readonly TuiModelOption[];
  filteredSlashCommands: readonly SlashCommand[];
  key: KeyEvent;
  modelSelection: ModelCommandSelectionState | undefined;
  modeSelection: ModeCommandSelectionState | undefined;
  setEffortSelection: Dispatch<SetStateAction<EffortCommandSelectionState | undefined>>;
  setModeSelection: Dispatch<SetStateAction<ModeCommandSelectionState | undefined>>;
  setModelSelection: Dispatch<SetStateAction<ModelCommandSelectionState | undefined>>;
  setSlashSelection: Dispatch<SetStateAction<SlashSelectionState | undefined>>;
  slashSelection: SlashSelectionState | undefined;
};

export function handleSuggestionNavigationKey(input: SuggestionNavigationInput): boolean {
  const delta = suggestionNavigationDelta(input.key);
  if (delta === undefined) return false;

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredModelOptions.length,
      selection: input.modelSelection,
      setSelection: input.setModelSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredEffortOptions.length,
      selection: input.effortSelection,
      setSelection: input.setEffortSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredModeOptions.length,
      selection: input.modeSelection,
      setSelection: input.setModeSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  if (
    moveSuggestion({
      delta,
      optionCount: input.filteredSlashCommands.length,
      selection: input.slashSelection,
      setSelection: input.setSlashSelection,
    })
  ) {
    input.consumeKey(input.key);
    return true;
  }

  return false;
}

function suggestionNavigationDelta(key: KeyEvent): NavigationDelta | undefined {
  if (key.name === "up") return -1;
  if (key.name === "down") return 1;
  return undefined;
}

function moveSuggestion<TSelection extends SelectionWithIndex>({
  delta,
  optionCount,
  selection,
  setSelection,
}: {
  delta: NavigationDelta;
  optionCount: number;
  selection: TSelection | undefined;
  setSelection: Dispatch<SetStateAction<TSelection | undefined>>;
}): boolean {
  if (!selection || optionCount <= 0) return false;
  setSelection({
    ...selection,
    selectedIndex: clampIndex(selection.selectedIndex + delta, optionCount),
  });
  return true;
}
