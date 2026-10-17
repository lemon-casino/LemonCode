import { useEffect, useRef } from "react";
import type { StartupScenePreview } from "@lcode/shared/startup-animation";
import { useOptionalPlatform } from "./usePlatform.js";

export function useAemeathWallpaper(reduced: boolean, onReady: (ready: boolean) => void) {
  const platform = useOptionalPlatform();
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Pick<StartupScenePreview, "play" | "pause" | "dispose"> | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!container.current || !platform?.mountAemeathWallpaper) return;
    const instance = platform.mountAemeathWallpaper(container.current, onReady);
    player.current = instance;
    return () => {
      instance.dispose();
      player.current = undefined;
    };
  }, [platform, onReady]);
  useEffect(() => {
    if (reduced) player.current?.pause();
    else player.current?.play();
  }, [reduced, platform, onReady]);
  return container;
}
