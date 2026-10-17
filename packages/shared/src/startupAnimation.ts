import { z } from "zod";
import { startupSceneSchema, DEFAULT_STARTUP_SCENE } from "./startupScene.js";
export * from "./startupScene.js";

export const STARTUP_ANIMATION_PRESETS = ["baili", "aemeath", "custom"] as const;
export type StartupAnimationPreset = (typeof STARTUP_ANIMATION_PRESETS)[number];
const currentStartupAnimationSettingsSchema = z
  .object({
    preset: z.enum(STARTUP_ANIMATION_PRESETS).default("baili"),
    mode: z.enum(["simple", "cinematic", "off"]).default("simple"),
    volume: z.number().finite().min(0).max(1).default(0),
    scenes: z
      .object({
        baili: startupSceneSchema.optional(),
        aemeath: startupSceneSchema.optional(),
        custom: startupSceneSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const startupAnimationSettingsSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { scene, ...settings } = input as Record<string, unknown>;
  if (scene !== undefined) {
    if (
      settings.scenes !== undefined &&
      (!settings.scenes || typeof settings.scenes !== "object" || Array.isArray(settings.scenes))
    )
      return input;
    const scenes = settings.scenes as Record<string, unknown> | undefined;
    settings.scenes = { ...scenes, aemeath: scenes?.aemeath ?? scene };
  }
  // 删除旧素材后只在配置入口归一化，避免旧选择误播白璃或使整份应用设置校验失败。
  if (
    settings.preset === "dragon" ||
    (settings.preset === undefined && settings.mode === "cinematic")
  )
    return {
      ...settings,
      preset: "baili",
      mode: settings.mode === "cinematic" ? "simple" : settings.mode,
    };
  return settings;
}, currentStartupAnimationSettingsSchema);
export type StartupAnimationSettings = z.infer<typeof startupAnimationSettingsSchema>;
const defaultBailiScene = startupSceneSchema.parse({ accent: "#b7dbff", background: "#04070d" });
export function getDefaultStartupScene(preset: StartupAnimationPreset) {
  return preset === "baili" ? defaultBailiScene : DEFAULT_STARTUP_SCENE;
}
export function getStartupScene(settings: StartupAnimationSettings) {
  return (
    settings.scenes?.[settings.preset] ??
    (settings.preset !== "baili" ? DEFAULT_STARTUP_SCENE : undefined)
  );
}
export const STARTUP_ANIMATION_CHOICES = ["official", ...STARTUP_ANIMATION_PRESETS, "off"] as const;
export type StartupAnimationChoice = (typeof STARTUP_ANIMATION_CHOICES)[number];
export function getStartupAnimationChoice(
  settings: StartupAnimationSettings,
): StartupAnimationChoice {
  return settings.mode === "cinematic"
    ? settings.preset
    : settings.mode === "off"
      ? "off"
      : "official";
}
export function startupAnimationChoicePatch(
  choice: StartupAnimationChoice,
): Partial<StartupAnimationSettings> {
  // 原来的 mode/preset 二级选择会锁住默认预设；单一选择一次写入两个旧字段，保留配置兼容。
  return choice === "official"
    ? { mode: "simple" }
    : choice === "off"
      ? { mode: "off" }
      : { mode: "cinematic", preset: choice };
}
export type StartupSurface = "loading" | "welcome" | "ready" | "attention";

export const startupAnimationBootstrapSchema = z
  .object({
    enabled: z.boolean(),
    launchId: z.string().min(1).max(128),
    settings: startupAnimationSettingsSchema,
  })
  .strict();
export type StartupAnimationBootstrap = z.infer<typeof startupAnimationBootstrapSchema>;
