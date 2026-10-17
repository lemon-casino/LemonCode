import { useEffect, useRef, useState } from "react";
import { useWallpaper } from "@/hooks/useWallpaper.js";
import { useWallpaperMedia } from "@/hooks/useWallpaperMedia.js";
import { useAemeathWallpaper } from "@/hooks/useAemeathWallpaper.js";
import type { WallpaperRecord } from "@/store/wallpaperStorage.js";

function AemeathWallpaper({
  reduced,
  onReady,
}: {
  reduced: boolean;
  onReady(value: boolean): void;
}) {
  const container = useAemeathWallpaper(reduced, onReady);
  return <div ref={container} className="h-full w-full" />;
}

function WallpaperMedia({
  record,
  url,
  reduced,
  onReady,
}: {
  record: WallpaperRecord;
  url?: string;
  reduced: boolean;
  onReady(value: boolean): void;
}) {
  const still = useWallpaperMedia(record);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (reduced) element.pause();
    else
      void element.play().catch(() => {
        /* 自动播放拒绝时保留已解码静帧。 */
      });
  }, [reduced, url]);
  useEffect(() => {
    const element = video.current;
    return () => {
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
    };
  }, [record.source, url]);
  if (record.source === "aemeath" && url)
    return <AemeathWallpaper reduced={reduced} onReady={onReady} />;
  if (record.source === "baili" && url)
    return (
      <video
        ref={video}
        src={url}
        muted
        loop
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
        data-testid="wallpaper-video"
        onLoadedData={() => onReady(true)}
        onError={() => onReady(false)}
      />
    );
  return still ? (
    <img
      src={still}
      alt=""
      className="h-full w-full object-cover"
      data-testid="wallpaper-image"
      onLoad={() => onReady(true)}
      onError={() => onReady(false)}
    />
  ) : null;
}

export function WorkspaceWallpaper({ active = true }: { active?: boolean }) {
  const { record, supported, builtinUrl } = useWallpaper();
  const layer = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(
    () => typeof document !== "undefined" && !document.hidden,
  );
  const [starting, setStarting] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("lcode-startup-active"),
  );
  const [reduced, setReduced] = useState(
    () =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [ready, setReady] = useState(false);
  const enabled =
    supported && active && visible && foreground && !starting && record.source !== "none";
  useEffect(() => {
    if (!supported || !layer.current) return;
    const shell = layer.current.parentElement!;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry?.isIntersecting ?? false),
    );
    observer.observe(shell);
    const visibility = () => setForeground(!document.hidden);
    const startup = new MutationObserver(() =>
      setStarting(document.documentElement.classList.contains("lcode-startup-active")),
    );
    startup.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(motion.matches);
    document.addEventListener("visibilitychange", visibility);
    motion.addEventListener("change", change);
    return () => {
      observer.disconnect();
      startup.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      motion.removeEventListener("change", change);
    };
  }, [supported]);
  useEffect(() => {
    const shell = layer.current?.parentElement;
    if (enabled && ready) shell?.setAttribute("data-wallpaper-active", "true");
    else shell?.removeAttribute("data-wallpaper-active");
    return () => shell?.removeAttribute("data-wallpaper-active");
  }, [enabled, ready]);
  useEffect(() => {
    setReady(false);
  }, [record, enabled]);
  if (!supported) return null;
  const url =
    record.source === "baili" || record.source === "aemeath"
      ? builtinUrl(record.source)
      : undefined;
  return (
    <div
      ref={layer}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      data-testid="workspace-wallpaper"
    >
      {enabled ? (
        <WallpaperMedia record={record} url={url} reduced={reduced} onReady={setReady} />
      ) : null}
      <div className="absolute inset-0" data-wallpaper-tint="true" />
    </div>
  );
}
