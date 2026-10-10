import { VideoProcessorPortError, type VideoTranscriptSegment } from "@lcode/contracts";

export function videoFrameTimes(start: number, end: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / count);
}

export function parseVideoSubtitles(text: string): VideoTranscriptSegment[] {
  const result: VideoTranscriptSegment[] = [];
  for (const block of text
    .replace(/^\uFEFF/u, "")
    .replace(/\r/gu, "")
    .split(/\n\s*\n/u)) {
    const lines = block.trim().split("\n");
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)/u.exec(lines[timing]!);
    if (!match) continue;
    const start = subtitleSeconds(match[1]!);
    const end = subtitleSeconds(match[2]!);
    const content = lines
      .slice(timing + 1)
      .join("\n")
      .replace(/<[^>]*>/gu, "")
      .trim();
    if (start !== undefined && end !== undefined && end > start && content)
      result.push({ start, end, text: content });
  }
  return result;
}

function subtitleSeconds(value: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/u.exec(value);
  if (!match || Number(match[2]) >= 60 || Number(match[3]) >= 60) return undefined;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

export function measureVideoMotion(
  frames: Uint8Array[],
  width: number,
  height: number,
): {
  changeRatios: number[];
  changedRegion?: { x: number; y: number; width: number; height: number };
} {
  const pixels = width * height;
  if (frames.some((frame) => frame.byteLength !== pixels * 3))
    throw new VideoProcessorPortError(
      "process_failed",
      "Motion sample has an invalid RGB byte length.",
    );
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  const changeRatios: number[] = [];
  for (let index = 1; index < frames.length; index++) {
    let changed = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      const offset = pixel * 3;
      const delta =
        [0, 1, 2].reduce(
          (sum, channel) =>
            sum +
            Math.abs(frames[index]![offset + channel]! - frames[index - 1]![offset + channel]!),
          0,
        ) / 3;
      if (delta < 16) continue;
      changed++;
      const x = pixel % width,
        y = Math.floor(pixel / width);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    changeRatios.push(changed / pixels);
  }
  return {
    changeRatios,
    ...(right >= 0
      ? {
          changedRegion: {
            x: left / width,
            y: top / height,
            width: (right - left + 1) / width,
            height: (bottom - top + 1) / height,
          },
        }
      : {}),
  };
}
