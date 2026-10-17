import { aemeathBlink } from "@lcode/shared/startup-animation";
import { drawAemeathPortrait, loadAemeathClosedEyes } from "./aemeathPortrait.js";

/** 仅拥有展示时钟；选择、可见性与减少动态效果由 UI 的现有壁纸路径控制。 */
export function mountAemeathWallpaper(
  target: { readonly nodeType: number },
  onReady: (ready: boolean) => void,
) {
  if (!(target instanceof HTMLElement)) throw new Error("Invalid wallpaper target");
  const container = target;
  const canvas = document.createElement("canvas");
  canvas.dataset.testid = "wallpaper-aemeath";
  Object.assign(canvas.style, { width: "100%", height: "100%", display: "block" });
  container.append(canvas);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas unavailable");
  const image = new Image();
  let closedEyes: HTMLImageElement | undefined;
  let disposed = false,
    loaded = false,
    requested = false,
    frame = 0,
    origin = 0,
    elapsed = 0;
  function draw(blink = 0) {
    if (!ctx || disposed || !loaded || !closedEyes) return;
    const scale = Math.max(canvas.width / 1536, canvas.height / 1024);
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      (canvas.width - 1536 * scale) / 2,
      (canvas.height - 1024 * scale) / 2,
    );
    drawAemeathPortrait(ctx, image, closedEyes, blink);
    canvas.dataset.blink = blink.toFixed(3);
    canvas.dataset.elapsed = elapsed.toFixed(3);
  }
  function size() {
    const box = container.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2, 1920 / Math.max(1, box.width));
    canvas.width = Math.max(1, Math.round(box.width * ratio));
    canvas.height = Math.max(1, Math.round(box.height * ratio));
    draw(requested ? aemeathBlink(elapsed) : 0);
  }
  function stop() {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  function tick(now: number) {
    frame = 0;
    if (disposed || !loaded || !requested || document.hidden) return;
    elapsed = (now - origin) / 1000;
    const blink = aemeathBlink(elapsed);
    // 睁眼间歇不重复重绘整幅背景，眨眼和尺寸变化才更新像素。
    if (blink > 0 || canvas.dataset.blink !== "0.000") draw(blink);
    canvas.dataset.elapsed = elapsed.toFixed(3);
    frame = requestAnimationFrame(tick);
  }
  function resume() {
    if (disposed || !loaded || !requested || frame || document.hidden) return;
    origin = performance.now() - elapsed * 1000;
    frame = requestAnimationFrame(tick);
  }
  const visibility = () => {
    if (document.hidden) stop();
    else resume();
  };
  const resize = new ResizeObserver(size);
  resize.observe(container);
  document.addEventListener("visibilitychange", visibility);
  size();
  image.src = new URL("./startup-media/aemeath-artwork.jpg", document.baseURI).href;
  void Promise.all([loadAemeathClosedEyes(), image.decode()])
    .then(([closed]) => {
      // 切换壁纸后旧解码不能重新发布 ready 或重建帧循环。
      if (disposed) return;
      loaded = true;
      closedEyes = closed;
      size();
      canvas.dataset.ready = "true";
      onReady(true);
      resume();
    })
    .catch(() => {
      if (!disposed) onReady(false);
    });
  return {
    play() {
      requested = true;
      resume();
    },
    pause() {
      requested = false;
      stop();
      draw();
    },
    dispose() {
      disposed = true;
      stop();
      resize.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      image.removeAttribute("src");
      closedEyes = undefined;
      canvas.remove();
    },
  };
}
