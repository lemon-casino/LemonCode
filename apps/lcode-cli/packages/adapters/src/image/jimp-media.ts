import { JimpMime } from "jimp";
import { detectImageMediaType } from "@lcode/contracts";

type JimpOutputMime =
  | typeof JimpMime.bmp
  | typeof JimpMime.gif
  | typeof JimpMime.jpeg
  | typeof JimpMime.png
  | typeof JimpMime.tiff;

export { detectImageMediaType };

export function normalizeMediaType(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (
    lower === "image/jpeg" ||
    lower === "image/png" ||
    lower === "image/gif" ||
    lower === "image/webp"
  ) {
    return lower;
  }
  return JimpMime.png;
}

export function jimpOutputMediaType(
  requested: string,
  detected: string | undefined,
): JimpOutputMime {
  if (isJimpOutputMime(requested)) return requested;
  if (detected && isJimpOutputMime(detected)) return detected;
  return JimpMime.png;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("Image resize was cancelled");
}

function isJimpOutputMime(value: string): value is JimpOutputMime {
  return (
    value === JimpMime.bmp ||
    value === JimpMime.gif ||
    value === JimpMime.jpeg ||
    value === JimpMime.png ||
    value === JimpMime.tiff
  );
}
