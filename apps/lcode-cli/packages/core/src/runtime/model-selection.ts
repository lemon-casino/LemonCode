import type { ModelSelection } from "@lcode/contracts";

export function cloneModelSelection(selection: ModelSelection): ModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}
