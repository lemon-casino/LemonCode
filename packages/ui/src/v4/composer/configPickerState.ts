export type V4ComposerConfigPicker = "mode" | "model" | "thought" | "speed";

export function resolveV4ComposerConfigPickerState(
  current: V4ComposerConfigPicker | null,
  picker: V4ComposerConfigPicker,
  open: boolean,
): V4ComposerConfigPicker | null {
  if (open) {
    return picker;
  }
  return current === picker ? null : current;
}
