import { startupSceneMediaKind } from "@lcode/shared/startup-animation";

type ResourceBase = { width: number; height: number; dispose(): void };
export type SceneResource = ResourceBase &
  (
    | { kind: "image"; element: HTMLImageElement }
    | { kind: "video"; element: HTMLVideoElement; duration: number }
  );

/** 解码、对象 URL 和取消属于同一资源实例；换图不能留下旧视频解码器。 */
export async function loadSceneResource(
  source: Blob | string,
  kind: "image" | "video",
  signal?: AbortSignal,
): Promise<SceneResource> {
  if (source instanceof Blob && startupSceneMediaKind(source) !== kind)
    throw new Error("Invalid resource kind");
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  const element = kind === "video" ? document.createElement("video") : new Image();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (element instanceof HTMLVideoElement) element.pause();
    element.removeAttribute("src");
    if (element instanceof HTMLVideoElement) element.load();
    if (source instanceof Blob) URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const event = kind === "video" ? "loadeddata" : "load";
      const clear = () => {
        element.removeEventListener(event, ready);
        element.removeEventListener("error", fail);
        signal?.removeEventListener("abort", abort);
      };
      const ready = () => {
        clear();
        resolve();
      };
      const fail = () => {
        clear();
        reject(new Error("Cannot decode background resource"));
      };
      const abort = () => {
        clear();
        dispose();
        reject(new DOMException("Resource replaced", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      element.addEventListener(event, ready, { once: true });
      element.addEventListener("error", fail, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      if (element instanceof HTMLVideoElement) {
        element.muted = true;
        element.loop = true;
        element.playsInline = true;
        element.preload = "auto";
      }
      element.src = url;
      if (element instanceof HTMLVideoElement) element.load();
    });
    const video = element instanceof HTMLVideoElement;
    const width = video ? element.videoWidth : element.naturalWidth;
    const height = video ? element.videoHeight : element.naturalHeight;
    if (!width || !height || width * height > 40_000_000)
      throw new Error("Invalid background dimensions");
    if (video) {
      if (!Number.isFinite(element.duration) || element.duration <= 0 || element.duration > 120)
        throw new Error("Invalid background duration");
      return { kind: "video", element, width, height, duration: element.duration, dispose };
    }
    return { kind: "image", element, width, height, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

export async function validateStartupSceneMedia(media: Blob) {
  const resource = await loadSceneResource(media, startupSceneMediaKind(media));
  resource.dispose();
}
