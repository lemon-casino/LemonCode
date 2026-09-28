import { useLCodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useLCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}
