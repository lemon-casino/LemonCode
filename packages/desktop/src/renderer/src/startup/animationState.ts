import type {
  StartupAnimationSettings,
  StartupAnimationPreset,
  StartupSurface,
} from "@lcode/shared/startup-animation";
import {
  sceneTiming,
  DEFAULT_STARTUP_SCENE,
  type StartupSceneSettings,
} from "@lcode/shared/startup-animation";

export const ANIMATION_TIMELINES = {
  baili: { holdAt: 14, transitionStart: 15, transitionEnd: 15.95 },
  aemeath: sceneTiming(DEFAULT_STARTUP_SCENE),
  custom: sceneTiming(DEFAULT_STARTUP_SCENE),
} satisfies Record<
  StartupAnimationPreset,
  { holdAt: number; transitionStart: number; transitionEnd: number }
>;
export type AnimationFinishReason =
  | "skip"
  | "media-error"
  | "ended"
  | "watchdog"
  | "attention"
  | "reduced-motion"
  | "complete";

/** 只有展示状态；不生成数据库 ready、不持有业务恢复状态。 */
export class StartupAnimationState {
  private displayReady = false;
  private currentSurface: StartupSurface = "loading";
  private ambient = false;
  get isAmbient() {
    return this.ambient;
  }
  reason: AnimationFinishReason | undefined;
  readonly timeline: (typeof ANIMATION_TIMELINES)[StartupAnimationPreset];
  constructor(
    readonly mode: StartupAnimationSettings["mode"],
    preset: StartupAnimationPreset = "baili",
    scene?: StartupSceneSettings,
  ) {
    this.timeline =
      scene || preset === "aemeath"
        ? sceneTiming(scene ?? DEFAULT_STARTUP_SCENE)
        : ANIMATION_TIMELINES[preset];
  }
  surface(surface: StartupSurface) {
    this.currentSurface = surface;
    this.displayReady = surface === "ready";
    if (this.displayReady) this.ambient = false;
    if (surface === "attention") this.finish("attention");
  }
  finish(reason: AnimationFinishReason) {
    this.reason ??= reason;
  }
  frame(time: number): "finished" | "hold" | "ambient" | "play" | "transition" {
    if (this.reason) return "finished";
    // 欢迎是用户决策阶段，不是解码停帧；循环回片头及确认后的加载都不提前交接。
    if (this.ambient || (this.currentSurface === "welcome" && time >= this.timeline.holdAt)) {
      this.ambient = true;
      return "ambient";
    }
    if (!this.displayReady && time >= this.timeline.holdAt) return "hold";
    if (this.displayReady && time >= this.timeline.transitionStart) return "transition";
    return "play";
  }
}
