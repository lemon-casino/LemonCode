import {
  sceneEase,
  aemeathBlink,
  sceneFragmentArrival,
  sceneTiming,
  startupSceneSchema,
  sceneResourceTime,
  sceneSubtitleVisible,
  startupSceneMediaKind,
  type StartupAnimationPreset,
  type StartupSceneSettings,
  type StartupScenePreview,
} from "@lcode/shared/startup-animation";
import { readStartupSceneImage } from "./sceneImages.js";
import { loadAemeathClosedEyes } from "./aemeathPortrait.js";
import { createSceneArtwork } from "./sceneArtwork.js";
import { createSceneFragments, sampleSceneContours } from "./sceneContours.js";
import { loadSceneResource, type SceneResource } from "./sceneResource.js";
import { customSceneArtwork } from "./customArtwork.js";
import { StartupSceneClock } from "./sceneClock.js";

type Point = [number, number];
type Path = Point[];
interface SceneOptions {
  onTime?: (seconds: number) => void;
  onEnd?: () => void;
  onError?: () => void;
  image?: Blob;
  preset?: StartupAnimationPreset;
}
const asset = (name: string) => new URL(`./startup-media/${name}`, document.baseURI).href;
const clamp = (t: number) => Math.max(0, Math.min(1, t));

/** 同一渲染器用于制作区和首窗；只持有展示时钟，不读取任何业务 ready。 */
export function createStartupScene(
  container: HTMLElement,
  initial: StartupSceneSettings,
  options: SceneOptions = {},
) {
  const canvas = document.createElement("canvas");
  canvas.className = "startup-video";
  canvas.dataset.testid = "startup-scene";
  canvas.setAttribute("aria-label", "Startup animation canvas");
  Object.assign(canvas.style, { width: "100%", height: "100%", display: "block" });
  container.prepend(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas unavailable");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let settings = startupSceneSchema.parse(initial),
    closedEyes: HTMLImageElement | undefined,
    paths: Path[] = [];
  const clock = new StartupSceneClock();
  let playing = false,
    frame = 0,
    disposed = false,
    epoch = 0,
    loaded = false,
    resumeOnVisible = false;
  let resource: SceneResource | undefined, loadAbort: AbortController | undefined;
  const artwork = createSceneArtwork();
  let pieces: ReturnType<typeof createSceneFragments> = [];
  function draw() {
    if (!ctx || disposed) return;
    const elapsed = clock.elapsed;
    const w = canvas.width,
      h = canvas.height,
      d = settings.durations;
    const scatterStart = d.pulse,
      traceStart = scatterStart + d.scatter,
      colorStart = traceStart + d.trace;
    const displayStart = colorStart + d.color,
      collapseStart = displayStart + d.display;
    const ease = (value: number) => sceneEase(settings.easing, clamp(value));
    const collapse =
      elapsed >= collapseStart ? clamp(ease((elapsed - collapseStart) / d.collapse)) : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = settings.background;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, Math.max(0.001, 1 - collapse));
    ctx.translate(-w / 2, -h / 2);
    if (elapsed < scatterStart) {
      const phase = clamp(elapsed / d.pulse);
      ctx.strokeStyle = settings.accent;
      ctx.lineWidth = Math.max(1, w / 700);
      for (let i = 0; i < 2; i++) {
        const p = (phase * 1.4 + i * 0.5) % 1;
        ctx.globalAlpha = (1 - p) * (1 - clamp((phase - 0.7) / 0.3));
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, ((12 + p * 48) * w) / 1280, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1 - clamp((phase - 0.75) / 0.25);
      ctx.fillStyle = settings.accent;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 400, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const spread = ease((elapsed - scatterStart) / d.scatter),
        assembled = ease((elapsed - traceStart) / d.trace);
      const color = clamp(ease((elapsed - colorStart) / d.color));
      const scale = Math.max(w / 1536, h / 1024) * settings.imageScale,
        dx = (w * settings.imagePosition.x) / 100 - (1536 * scale) / 2,
        dy = (h * settings.imagePosition.y) / 100 - (1024 * scale) / 2;
      ctx.save();
      ctx.translate(dx, dy);
      ctx.scale(scale, scale);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = settings.accent;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      for (const piece of pieces) {
        const arrival = sceneFragmentArrival(settings.easing, assembled, piece.x / 1536);
        const startX = 768 + (piece.sx - 768) * spread,
          startY = 512 + (piece.sy - 512) * spread;
        const x = startX + (piece.x - startX) * arrival,
          y = startY + (piece.y - startY) * arrival;
        const angle = piece.angle * (1 - arrival),
          size = 0.2 + 0.8 * arrival,
          cs = Math.cos(angle) * size,
          sn = Math.sin(angle) * size;
        piece.points.forEach(([px, py], i) => {
          const nx = x + (px - piece.x) * cs - (py - piece.y) * sn,
            ny = y + (px - piece.x) * sn + (py - piece.y) * cs;
          if (i) ctx.lineTo(nx, ny);
          else ctx.moveTo(nx, ny);
        });
      }
      ctx.stroke();
      if (resource && color > 0)
        artwork.draw(
          ctx,
          resource,
          closedEyes,
          color,
          motion.matches ? 0 : aemeathBlink(clock.resource),
        );
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.shadowColor = settings.background;
    ctx.shadowBlur = w / 200;
    ctx.fillStyle = "#f8f0f8";
    const text = (
      value: string,
      size: number,
      position: { x: number; y: number },
      weight: number,
    ) => {
      ctx!.font = `${weight} ${(size * w) / 1280}px "Segoe UI","Microsoft YaHei",sans-serif`;
      ctx!.textBaseline = "middle";
      ctx!.fillText(
        value,
        (position.x / 100) * w,
        (position.y / 100) * h,
        Math.max(1, ((100 - position.x) / 100) * w),
      );
    };
    text(settings.title, settings.titleSize, settings.titlePosition, 700);
    const visibleSubtitles = settings.subtitles.filter((cue) =>
      sceneSubtitleVisible(cue, elapsed, sceneTiming(settings).duration),
    );
    for (const cue of visibleSubtitles) text(cue.text, cue.size, cue.position, 400);
    ctx.restore();
    if (collapse > 0.3 && collapse < 1) {
      ctx.globalAlpha = 1 - collapse;
      ctx.strokeStyle = settings.accent;
      ctx.beginPath();
      ctx.moveTo((w * collapse) / 2, h / 2);
      ctx.lineTo(w * (1 - collapse / 2), h / 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    canvas.dataset.phase =
      elapsed < scatterStart
        ? "pulse"
        : elapsed < traceStart
          ? "scatter"
          : elapsed < colorStart
            ? "trace"
            : elapsed < displayStart
              ? "color"
              : elapsed < collapseStart
                ? "display"
                : "collapse";
    canvas.dataset.elapsed = elapsed.toFixed(3);
    canvas.dataset.blink = (
      closedEyes && !motion.matches ? aemeathBlink(clock.resource) : 0
    ).toFixed(3);
    canvas.dataset.resourceClock = clock.resource.toFixed(3);
    canvas.dataset.subtitles = JSON.stringify(visibleSubtitles.map((cue) => cue.text));
    canvas.dataset.contours = String(paths.length);
    canvas.dataset.contourPoints = String(paths.reduce((sum, path) => sum + path.length, 0));
    canvas.dataset.resourceKind = resource?.kind ?? "loading";
    canvas.dataset.resourceTime =
      resource?.kind === "video" ? resource.element.currentTime.toFixed(3) : "0.000";
    canvas.dataset.mediaReady = String(resource?.kind !== "video" || !resource.element.seeking);
  }
  function size() {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) {
      pause();
      return;
    }
    const ratio = Math.min(devicePixelRatio || 1, 2, 1920 / Math.max(1, r.width));
    canvas.width = Math.max(320, Math.round(r.width * ratio));
    canvas.height = Math.max(180, Math.round(r.height * ratio));
    draw();
  }
  const resize = new ResizeObserver(size);
  resize.observe(container);
  size();
  const mediaError = () => {
    if (!disposed) options.onError?.();
  };
  function releaseResource() {
    resource?.element.removeEventListener("seeked", draw);
    resource?.element.removeEventListener("error", mediaError);
    resource?.dispose();
    resource = undefined;
  }
  function syncResource(seek = false) {
    if (resource?.kind !== "video") return;
    const video = resource.element;
    const start = settings.durations.pulse + settings.durations.scatter + settings.durations.trace;
    const time = motion.matches
      ? 0
      : sceneResourceTime(settings, clock.resource, resource.duration);
    const active = playing && !document.hidden && !motion.matches && clock.elapsed >= start;
    if ((seek || !active || video.paused) && Math.abs(video.currentTime - time) > 0.035)
      video.currentTime = time;
    if (active && video.paused)
      void video.play().catch(() => {
        if (resource?.element === video) mediaError();
      });
    if (!active) video.pause();
  }
  async function load(blob?: Blob) {
    const current = ++epoch,
      desired = settings;
    loadAbort?.abort();
    const abort = new AbortController();
    loadAbort = abort;
    let next: SceneResource | undefined;
    try {
      const custom =
        desired.image === "custom"
          ? (blob ?? (await readStartupSceneImage(desired.imageId)))
          : undefined;
      if (disposed || current !== epoch) return;
      // 自选资源丢失应明确失败，不能悄悄退回另一张内置人物图。
      if (desired.image === "custom" && !custom)
        throw new Error("Missing local background resource");
      const nativeAemeath = !custom && options.preset !== "baili" && options.preset !== "custom";
      next = await loadSceneResource(
        custom ??
          (options.preset === "custom"
            ? customSceneArtwork
            : asset(nativeAemeath ? "aemeath-artwork.jpg" : "baili-wallpaper.mp4")),
        custom
          ? startupSceneMediaKind(custom)
          : nativeAemeath || options.preset === "custom"
            ? "image"
            : "video",
        abort.signal,
      );
      const closed = nativeAemeath ? await loadAemeathClosedEyes() : undefined;
      const lines = nativeAemeath
        ? await fetch(asset("aemeath-contours.json"), { signal: abort.signal }).then((response) => {
            if (!response.ok) throw new Error("Missing contours");
            return response.json() as Promise<Path[]>;
          })
        : sampleSceneContours(next.element, next.width, next.height, desired.background);
      // 解码与提取轮廓后再次核对代次，旧草稿不能复活已替换或卸载的媒体。
      if (disposed || current !== epoch) return;
      releaseResource();
      resource = next;
      next = undefined;
      resource.element.addEventListener("seeked", draw);
      resource.element.addEventListener("error", mediaError);
      closedEyes = closed;
      paths = lines;
      pieces = createSceneFragments(paths);
      loaded = true;
      canvas.dataset.resourceOrigin = custom ? "custom" : "builtin";
      syncResource(true);
      draw();
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!disposed && current === epoch) options.onError?.();
      throw error;
    } finally {
      next?.dispose();
    }
  }
  function pause() {
    resumeOnVisible = false;
    playing = false;
    cancelAnimationFrame(frame);
    frame = 0;
    if (resource?.kind === "video") resource.element.pause();
  }
  function tick(now: number) {
    if (!playing || disposed) return;
    clock.advance(now, sceneTiming(settings).duration);
    syncResource();
    draw();
    options.onTime?.(clock.elapsed);
    if (!playing || disposed) return;
    if (clock.elapsed >= sceneTiming(settings).duration) {
      pause();
      options.onEnd?.();
    } else frame = requestAnimationFrame(tick);
  }
  function play() {
    if (!loaded || disposed || playing) return;
    if (document.hidden) {
      resumeOnVisible = true;
      return;
    }
    if (clock.elapsed >= sceneTiming(settings).duration) clock.seek(0, performance.now());
    playing = true;
    clock.resume(performance.now());
    syncResource(true);
    frame = requestAnimationFrame(tick);
  }
  const hidden = () => {
    if (document.hidden) {
      const resume = playing;
      pause();
      resumeOnVisible = resume;
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      play();
    }
  };
  document.addEventListener("visibilitychange", hidden);
  const motionChange = () => {
    syncResource(true);
    draw();
  };
  motion.addEventListener("change", motionChange);
  const ready = load(options.image);
  let previousImage = options.image;
  return {
    ready,
    get paused() {
      return !playing;
    },
    update(next: StartupSceneSettings, blob?: Blob) {
      const reload =
        settings.image !== next.image ||
        settings.imageId !== next.imageId ||
        blob !== previousImage;
      settings = startupSceneSchema.parse(next);
      previousImage = blob;
      clock.seek(Math.min(clock.elapsed, sceneTiming(settings).duration), performance.now());
      draw();
      if (reload) void load(blob).catch(() => {});
    },
    seek(seconds: number) {
      clock.seek(Math.max(0, Math.min(sceneTiming(settings).duration, seconds)), performance.now());
      syncResource(true);
      draw();
      options.onTime?.(clock.elapsed);
    },
    setAmbient(enabled: boolean) {
      clock.setAmbient(enabled, performance.now(), sceneTiming(settings).holdAt);
    },
    play,
    pause,
    dispose() {
      disposed = true;
      epoch++;
      loadAbort?.abort();
      pause();
      resize.disconnect();
      document.removeEventListener("visibilitychange", hidden);
      motion.removeEventListener("change", motionChange);
      releaseResource();
      artwork.dispose();
      closedEyes = undefined;
      paths = [];
      pieces = [];
      canvas.remove();
    },
  };
}
export function mountStartupScenePreview(
  container: { readonly nodeType: number },
  settings: StartupSceneSettings,
  onTime?: (seconds: number) => void,
  preset?: StartupAnimationPreset,
): StartupScenePreview {
  if (!(container instanceof HTMLElement)) throw new Error("Invalid scene preview target");
  const scene = createStartupScene(container, settings, { onTime, preset });
  void scene.ready
    .then(() => scene.seek(sceneTiming(settings).transitionStart - 0.2))
    .catch(() => {});
  return scene;
}
