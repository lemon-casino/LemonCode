import { useEffect } from "react";
import { useWallpaperStore } from "@/store/wallpaperStore.js";
import { useOptionalPlatform } from "./usePlatform.js";

export function useWallpaper() {
  const state = useWallpaperStore();
  const platform = useOptionalPlatform();
  const supported = Boolean(platform?.getBuiltinWallpaperUrl);
  useEffect(() => {
    if (supported) void state.initialize();
  }, [supported, state.initialize]);
  return {
    ...state,
    supported,
    builtinUrl: (source: "baili" | "aemeath") => platform?.getBuiltinWallpaperUrl?.(source),
  };
}
