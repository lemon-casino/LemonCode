import { z } from "zod";

export const SCENE_EASINGS = [
  "linear",
  "quadraticOut",
  "cubicInOut",
  "sineInOut",
  "exponentialOut",
  "backOut",
  "bounceOut",
] as const;
const position = (x: number, y: number) =>
  z
    .object({
      x: z.number().finite().min(0).max(100).default(x),
      y: z.number().finite().min(0).max(100).default(y),
    })
    .strict()
    .default({ x, y });
const seconds = (value: number) => z.number().finite().min(0.3).max(6).default(value);
const subtitleSchema = z
  .object({
    id: z.string().min(1).max(64),
    text: z.string().max(120),
    position: position(7, 90),
    size: z.number().finite().min(10).max(60).default(22),
    start: z.number().finite().min(0).max(36).default(0),
    end: z.number().finite().min(0).max(36).optional(),
  })
  .strict()
  .refine((cue) => cue.end === undefined || cue.end > cue.start, "Invalid subtitle interval");
const sceneSchema = z
  .object({
    // 历史自定义标题在共享读取边界归一，防止预览与冷启动展示不同品牌。
    title: z
      .string()
      .max(40)
      .default("LCode")
      .transform(() => "LCode" as const),
    subtitles: z
      .array(subtitleSchema)
      .max(8)
      .refine(
        (cues) => new Set(cues.map((cue) => cue.id)).size === cues.length,
        "Duplicate subtitle id",
      ),
    titlePosition: position(7, 83),
    imagePosition: position(50, 50),
    imageScale: z.number().finite().min(0.5).max(2).default(1),
    titleSize: z.number().finite().min(14).max(100).default(48),
    accent: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default("#dea7c9"),
    background: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default("#08060d"),
    image: z.enum(["builtin", "custom"]).default("builtin"),
    imageId: z.string().uuid().optional(),
    easing: z.enum(SCENE_EASINGS).default("cubicInOut"),
    durations: z
      .object({
        pulse: seconds(1.2),
        scatter: seconds(0.8),
        trace: seconds(2),
        color: seconds(0.5),
        display: seconds(3.5),
        collapse: seconds(1),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export const startupSceneSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { subtitle, subtitlePosition, subtitleSize, ...scene } = input as Record<string, unknown>;
  // 单字幕只在读取入口迁移，不保留第二条写入路径，已有多字幕优先。
  return {
    ...scene,
    subtitles:
      scene.subtitles === undefined
        ? [
            {
              id: "subtitle-1",
              text:
                subtitle === undefined || subtitle === "幽灵来到…你身边～"
                  ? "欢迎回来…主人 ～"
                  : subtitle,
              position: subtitlePosition,
              size: subtitleSize,
              start: 0,
            },
          ]
        : scene.subtitles,
  };
}, sceneSchema);
export type StartupSceneSettings = z.infer<typeof startupSceneSchema>;
export const DEFAULT_STARTUP_SCENE = startupSceneSchema.parse({});
export function sceneSubtitleVisible(
  cue: StartupSceneSettings["subtitles"][number],
  time: number,
  duration: number,
) {
  return time >= cue.start && time < Math.min(cue.end ?? duration, duration);
}
export function sceneResourceTime(scene: StartupSceneSettings, elapsed: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const start = scene.durations.pulse + scene.durations.scatter + scene.durations.trace;
  return Math.max(0, elapsed - start) % duration;
}
export function startupSceneMediaKind(file: { type: string; size: number }): "image" | "video" {
  const video = ["video/mp4", "video/webm"].includes(file.type);
  const image = ["image/png", "image/jpeg", "image/webp", "image/avif"].includes(file.type);
  if (
    (!video && !image) ||
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > (video ? 100 : 10) * 1024 * 1024
  )
    throw new Error("Invalid startup background resource");
  return video ? "video" : "image";
}
/** 确定性眨眼：快速闭合、短暂停留、稍慢睁开，预览 seek 与壁纸共用。 */
export function aemeathBlink(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  const t = (seconds % 5.4) - 1.2;
  if (t < 0 || t >= 0.34) return 0;
  if (t < 0.11) return sceneEase("sineInOut", t / 0.11);
  if (t < 0.16) return 1;
  return 1 - sceneEase("sineInOut", (t - 0.16) / 0.18);
}
export function sceneTiming(scene: StartupSceneSettings) {
  const duration = Object.values(scene.durations).reduce((sum, value) => sum + value, 0);
  const transitionStart = duration - scene.durations.collapse;
  return {
    duration,
    holdAt: transitionStart - 0.1,
    transitionStart,
    transitionEnd: duration - 0.05,
  };
}
/** 描线的前沿从画面左侧之外开始，确保碎片阶段不提前生成左侧轮廓。 */
export function sceneFragmentArrival(
  kind: StartupSceneSettings["easing"],
  progress: number,
  targetX: number,
) {
  return sceneEase(kind, (progress * 1.5 - 0.25 - targetX + 0.16) / 0.32);
}
export function sceneEase(kind: StartupSceneSettings["easing"], progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  switch (kind) {
    case "quadraticOut":
      return t * (2 - t);
    case "cubicInOut":
      return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    case "sineInOut":
      return (1 - Math.cos(Math.PI * t)) / 2;
    case "exponentialOut":
      return t === 0 || t === 1 ? t : 1 - 2 ** (-10 * t);
    case "backOut":
      return t === 0 ? 0 : 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
    case "bounceOut": {
      let x = t;
      if (x < 1 / 2.75) return 7.5625 * x * x;
      if (x < 2 / 2.75) {
        x -= 1.5 / 2.75;
        return 7.5625 * x * x + 0.75;
      }
      if (x < 2.5 / 2.75) {
        x -= 2.25 / 2.75;
        return 7.5625 * x * x + 0.9375;
      }
      x -= 2.625 / 2.75;
      return 7.5625 * x * x + 0.984375;
    }
    default:
      return t;
  }
}

/** 平台提供同一渲染器；UI 草稿只通过这个展示接口更新，不拥有启动准入。 */
export interface StartupScenePreview {
  update(settings: StartupSceneSettings, image?: Blob): void;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  dispose(): void;
}
