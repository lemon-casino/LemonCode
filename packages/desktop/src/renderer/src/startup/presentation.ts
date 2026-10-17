import {
  startupAnimationBootstrapSchema,
  type StartupAnimationSettings,
  type StartupSurface,
  getStartupScene,
} from "@lcode/shared/startup-animation";
import { StartupAnimationState, type AnimationFinishReason } from "./animationState.js";
import { getStartupAnimationPresets } from "./media.js";
import { createStartupScene } from "./scene.js";
import { createStartupWelcome } from "./welcome.js";

let active: ReturnType<typeof createPresentation> | undefined;
let template: HTMLElement | undefined;
let shellReady = document.documentElement.dataset.startupShell === "ready";
let surface: StartupSurface =
  document.documentElement.dataset.startupSurface === "attention"
    ? "attention"
    : document.documentElement.dataset.startupSurface === "ready"
      ? "ready"
      : document.documentElement.dataset.startupSurface === "welcome"
        ? "welcome"
        : "loading";

function claimStartup(): StartupAnimationSettings {
  const off = { mode: "off", volume: 0, preset: "baili" } as const;
  try {
    const parsed = startupAnimationBootstrapSchema.safeParse(
      JSON.parse(new URLSearchParams(location.search).get("startupAnimation") ?? "null"),
    );
    if (!parsed.success || !parsed.data.enabled) return off;
    const { launchId, settings } = parsed.data;
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (
      navigation?.type === "reload" ||
      sessionStorage.getItem("lcode-startup-played") === launchId
    )
      return off;
    sessionStorage.setItem("lcode-startup-played", launchId);
    return settings;
  } catch {
    // 存储受限时不反复播放；这只撤下装饰，业务准入继续由原 owner 判定。
    return off;
  }
}

export function bootStartupPresentation() {
  if (active) return;
  const loading = document.getElementById("loading");
  if (!loading) return;
  template ??= loading.cloneNode(true) as HTMLElement;
  active = createPresentation(loading, claimStartup(), false);
}

export function notifyStartupShellReady() {
  shellReady = true;
  bootStartupPresentation();
  active?.shellReady();
}

export function notifyStartupSurface(next: StartupSurface) {
  surface = next;
  active?.surface(next);
}

export function previewStartupAnimation(settings: StartupAnimationSettings, image?: Blob) {
  active?.finish("skip");
  if (!template || settings.mode === "off") return;
  const loading = template.cloneNode(true) as HTMLElement;
  loading.classList.add("startup-preview");
  document.body.append(loading);
  active = createPresentation(loading, settings, true, image);
}

function createPresentation(
  loading: HTMLElement,
  settings: StartupAnimationSettings,
  preview: boolean,
  image?: Blob,
) {
  const root = document.getElementById("root");
  const templateScene = getStartupScene(settings);
  const state = new StartupAnimationState(settings.mode, settings.preset, templateScene);
  const timeline = state.timeline;
  const welcomeEnabled =
    !preview &&
    settings.mode === "cinematic" &&
    getStartupAnimationPresets().includes(settings.preset);
  const welcome = createStartupWelcome(root, welcomeEnabled, timeline.holdAt);
  const startedAt = performance.now();
  const cleanup: Array<() => void> = [];
  const focusBefore = document.activeElement;
  const wasInert = root?.inert ?? false;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let committed = preview || shellReady;
  let simpleDone = settings.mode === "off" || motion.matches;
  let video: HTMLVideoElement | undefined;
  let scene: ReturnType<typeof createStartupScene> | undefined;
  let frame: number | undefined;
  let usesVideoFrames = false;
  let lastTime = -1;
  let lastProgress = performance.now();
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let simpleTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | undefined;
  let disposed = false;
  if (root) root.inert = true;
  document.documentElement.classList.add("lcode-startup-active");
  loading.dataset.startupMode = settings.mode;
  loading.dataset.startupPreset = settings.preset;

  const listen = (target: EventTarget, event: string, handler: EventListener, capture = false) => {
    target.addEventListener(event, handler, capture);
    cleanup.push(() => target.removeEventListener(event, handler, capture));
  };
  const reveal = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) {
      if (usesVideoFrames) video?.cancelVideoFrameCallback(frame);
      else cancelAnimationFrame(frame);
    }
    clearInterval(watchdog);
    clearTimeout(simpleTimer);
    observer?.disconnect();
    const welcomeFocused = welcome.ownsFocus();
    welcome.dispose();
    scene?.dispose();
    for (const dispose of cleanup) dispose();
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    loading.remove();
    document.documentElement.classList.remove("lcode-startup-active");
    document.body.classList.add("lcode-startup-ready");
    if (root) root.inert = wasInert;
    // Portal 确认框可能已经接管焦点；因 attention 退场时不能把焦点抢回项目或预览按钮。
    if (
      !welcomeFocused &&
      state.reason !== "attention" &&
      focusBefore instanceof HTMLElement &&
      focusBefore.isConnected &&
      focusBefore !== document.body
    ) {
      focusBefore.focus({ preventScroll: true });
    } else if (!welcomeFocused && state.reason !== "attention" && root && !wasInert) {
      const input = root.querySelector<HTMLElement>(
        'textarea:not([disabled]),[contenteditable="true"]',
      );
      if (input) input.focus({ preventScroll: true });
      else {
        root.tabIndex = -1;
        root.focus({ preventScroll: true });
      }
    }
    document.dispatchEvent(
      new CustomEvent("lcode-startup-finished", {
        detail: {
          reason: state.reason ?? "complete",
          preview,
          elapsedMs: performance.now() - startedAt,
        },
      }),
    );
  };
  const finish = (reason: AnimationFinishReason) => {
    state.finish(reason);
    reveal();
  };
  const renderPhase = (time: number) => {
    if (time !== lastTime || state.isAmbient) {
      lastTime = time;
      lastProgress = performance.now();
    }
    const action = state.frame(time);
    welcome.sync(undefined, time);
    loading.dataset.startupPhase = action;
    if (action === "ambient") {
      scene?.setAmbient(true);
      if (video) video.loop = true;
    }
    if (action === "transition") {
      document.body.classList.add("lcode-startup-ready");
      loading.style.opacity = String(
        1 -
          Math.min(
            1,
            (time - timeline.transitionStart) / (timeline.transitionEnd - timeline.transitionStart),
          ),
      );
      if (time >= timeline.transitionEnd) finish("complete");
    }
    return action;
  };
  const maybeFinishSimple = () => {
    if (!video && !scene && simpleDone && committed) finish("complete");
  };
  const syncSurface = (next: StartupSurface) => {
    if (disposed) return;
    // 欢迎可等待任意时长；用户确认后的加载预算应从本次交接重新起算。
    lastProgress = performance.now();
    const wasAmbient = state.isAmbient;
    state.surface(next);
    if (next === "ready" && wasAmbient) {
      scene?.setAmbient(false);
      if (video) {
        video.loop = false;
        video.currentTime = timeline.holdAt;
      }
    }
    welcome.sync(next);
    // 首次欢迎可以合成到完整动画；手动登录、错误等 attention 仍立即让出。
    if (next === "attention" || (next === "welcome" && !welcomeEnabled)) finish("attention");
    else if (next === "ready" && video?.paused) {
      lastProgress = performance.now();
      void video.play().catch(() => finish("media-error"));
    } else if (next === "ready" && scene?.paused) {
      lastProgress = performance.now();
      scene.play();
    }
  };
  const reduced = () => {
    if (motion.matches) finish("reduced-motion");
  };
  listen(motion, "change", reduced);

  if (settings.mode === "off" || motion.matches) {
    if (motion.matches) state.finish("reduced-motion");
    maybeFinishSimple();
  } else {
    const chinese = (
      new URLSearchParams(location.search).get("locale") ?? navigator.language
    ).startsWith("zh");
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "startup-skip text-ui-base";
    skip.textContent = chinese ? "跳过动画 · Esc" : "Skip animation · Esc";
    loading.setAttribute("aria-label", chinese ? "正在启动" : "Starting");
    loading.append(skip);
    listen(skip, "click", () => finish("skip"));
    listen(
      window,
      "keydown",
      ((event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          finish("skip");
        } else if (welcome.visible && welcome.ownsFocus()) {
          // 保留按钮的原生回车/Tab 默认动作，阻止按键继续触发 Root 的项目全局快捷键。
          event.stopImmediatePropagation();
          return;
        } else if (event.key !== "Tab" && !loading.contains(event.target as Node))
          event.preventDefault();
        // 预览时全局快捷键已注册；capture 防止键盘命令落到背后的项目。
        event.stopImmediatePropagation();
      }) as EventListener,
      true,
    );
    if (preview) skip.focus({ preventScroll: true });
    // 错误边界和 Portal 确认框可能在 Root 门禁之外出现，展示层只能让出它们，不能推断业务成功。
    observer = new MutationObserver(() => {
      const attention = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="alert"],[role="alertdialog"],[role="dialog"]',
        ),
      ].some((element) => element.getClientRects().length > 0);
      if (attention) finish("attention");
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "data-state", "hidden"],
    });
    if (
      settings.mode === "cinematic" &&
      templateScene &&
      getStartupAnimationPresets().includes(settings.preset)
    ) {
      loading.querySelector<HTMLElement>(".startup-logo-shell")?.setAttribute("hidden", "");
      scene = createStartupScene(loading, templateScene, {
        preset: settings.preset,
        image,
        onTime(time) {
          if (disposed || !scene) return;
          const action = renderPhase(time);
          if (action === "hold" && !scene.paused) {
            scene.pause();
            scene.seek(timeline.holdAt);
          }
        },
        onEnd: () => finish("ended"),
        onError: () => finish("media-error"),
      });
      void scene.ready
        .then(() => {
          if (!disposed) scene?.play();
        })
        .catch(() => finish("media-error"));
      watchdog = setInterval(() => {
        if (
          !disposed &&
          performance.now() - lastProgress > (state.frame(lastTime) === "hold" ? 60_000 : 12_000)
        )
          finish("watchdog");
      }, 1000);
    } else if (
      settings.mode === "cinematic" &&
      getStartupAnimationPresets().includes(settings.preset)
    ) {
      loading.querySelector<HTMLElement>(".startup-logo-shell")?.setAttribute("hidden", "");
      video = document.createElement("video");
      video.className = "startup-video";
      video.playsInline = true;
      video.muted = settings.volume === 0;
      video.volume = settings.volume;
      video.preload = "auto";
      video.src = new URL(`./startup-media/${settings.preset}.mp4`, document.baseURI).href;
      video.setAttribute("aria-hidden", "true");
      loading.prepend(video);
      listen(video, "error", () => finish("media-error"));
      listen(video, "ended", () => finish("ended"));
      listen(video, "loadedmetadata", () => {
        if (!video || !Number.isFinite(video.duration) || video.duration < timeline.transitionEnd)
          finish("media-error");
      });
      const schedule = () => {
        usesVideoFrames = typeof video?.requestVideoFrameCallback === "function";
        frame = usesVideoFrames
          ? video!.requestVideoFrameCallback(tick)
          : requestAnimationFrame(tick);
      };
      const tick = () => {
        if (disposed || !video) return;
        const time = video.currentTime;
        const action = renderPhase(time);
        if (disposed) return;
        if (action === "hold" && !video.paused) {
          video.pause();
          video.currentTime = timeline.holdAt;
        }
        schedule();
      };
      schedule();
      watchdog = setInterval(() => {
        if (disposed || !video) return;
        // 停帧 watchdog 只释放装饰；等待点另有有限预算，不得通过时间伪造 ready。
        const budget = state.frame(video.currentTime) === "hold" ? 60_000 : 12_000;
        if (performance.now() - lastProgress > budget) finish("watchdog");
      }, 1000);
      void video.play().catch(() => finish("media-error"));
    } else {
      listen(loading.querySelector(".startup-logo-shell") ?? loading, "animationend", () => {
        simpleDone = true;
        maybeFinishSimple();
      });
      simpleTimer = setTimeout(() => {
        simpleDone = true;
        maybeFinishSimple();
      }, 800);
    }
  }
  syncSurface(preview ? "ready" : surface);
  const unload = () => finish("skip");
  if (!disposed) listen(window, "pagehide", unload);
  return {
    finish,
    surface: syncSurface,
    shellReady() {
      committed = true;
      maybeFinishSimple();
    },
  };
}
