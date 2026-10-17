import { STARTUP_ANIMATION_PRESETS } from "@lcode/shared/startup-animation";

declare const __LCODE_STARTUP_MEDIA_FILES__: readonly string[];

export function getStartupAnimationPresets() {
  return STARTUP_ANIMATION_PRESETS.filter((preset) =>
    preset === "custom"
      ? true
      : preset === "aemeath"
        ? ["aemeath-artwork.jpg", "aemeath-closed-eyes.png", "aemeath-contours.json"].every(
            (name) => __LCODE_STARTUP_MEDIA_FILES__.includes(name),
          )
        : __LCODE_STARTUP_MEDIA_FILES__.includes(`${preset}.mp4`),
  );
}

export function getBuiltinWallpaperUrl(preset: "baili" | "aemeath") {
  const file = preset === "aemeath" ? "aemeath-artwork.jpg" : "baili-wallpaper.mp4";
  if (preset === "aemeath" && !__LCODE_STARTUP_MEDIA_FILES__.includes("aemeath-closed-eyes.png"))
    return undefined;
  return __LCODE_STARTUP_MEDIA_FILES__.includes(file)
    ? new URL(`./startup-media/${file}`, document.baseURI).href
    : undefined;
}
