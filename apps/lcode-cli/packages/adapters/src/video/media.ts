import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VIDEO_INSPECT_MAX_FRAME_BYTES,
  VIDEO_INSPECT_MAX_IMAGE_BYTES,
  VIDEO_INSPECT_MAX_SUBTITLE_BYTES,
  VideoMetadataSchema,
  VideoProcessorPortError,
  type VideoMetadata,
  type VideoProcessorRequest,
  type VideoProcessorResult,
} from "@lcode/contracts";
import { measureVideoMotion, parseVideoSubtitles, videoFrameTimes } from "./analysis.js";
import { assertVideoNotCancelled, runVideoCommand, type VideoExecution } from "./execution.js";
import type { VideoSidecar } from "./sidecar.js";

// 视频文件可伪装成联网 playlist；限制本地容器与协议，避免只读检查隐式发网络请求。
const LOCAL_VIDEO_INPUT_ARGUMENTS = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi,mpeg,mpegvideo",
];

export async function probeVideo(
  snapshot: string,
  sizeBytes: number,
  execution: VideoExecution,
): Promise<VideoMetadata> {
  const result = await runVideoCommand(execution, "ffprobe", [
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-of",
    "json",
    ...LOCAL_VIDEO_INPUT_ARGUMENTS,
    snapshot,
  ]);
  try {
    const data = JSON.parse(result.stdout) as {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        duration?: string;
        avg_frame_rate?: string;
        r_frame_rate?: string;
      }>;
      format?: { duration?: string };
    };
    const streams = data.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const rate = (video?.avg_frame_rate ?? video?.r_frame_rate ?? "").split("/").map(Number);
    const frameRate = rate.length === 2 ? rate[0]! / rate[1]! : rate[0];
    return VideoMetadataSchema.parse({
      duration: Number(data.format?.duration ?? video?.duration),
      width: video?.width,
      height: video?.height,
      ...(frameRate && Number.isFinite(frameRate) && frameRate > 0 ? { frameRate } : {}),
      hasAudio: streams.some((stream) => stream.codec_type === "audio"),
      hasSubtitles: streams.some((stream) => stream.codec_type === "subtitle"),
      sizeBytes,
    });
  } catch (error) {
    throw new VideoProcessorPortError(
      "corrupted",
      "The source has no valid video stream or duration.",
      { cause: error },
    );
  }
}

export async function extractVideoMedia(input: {
  request: VideoProcessorRequest;
  metadata: VideoMetadata;
  snapshot: string;
  directory: string;
  execution: VideoExecution;
  sidecar?: VideoSidecar;
}): Promise<
  Pick<
    VideoProcessorResult,
    | "frames"
    | "sampleTimes"
    | "requestedSampleTimes"
    | "transcript"
    | "transcriptSource"
    | "truncated"
    | "motion"
  >
> {
  const { request, metadata, snapshot, directory, execution, sidecar } = input;
  const start = request.start ?? 0,
    end = request.end ?? metadata.duration;
  if (
    start >= metadata.duration ||
    end > metadata.duration ||
    end <= start ||
    request.timestamps?.some((time) => time >= metadata.duration)
  )
    throw new VideoProcessorPortError(
      "invalid_request",
      "Video timestamps or range fall outside the source duration.",
    );
  if (request.action === "inspect") return { frames: [], sampleTimes: [], truncated: false };
  if (request.action === "transcript") {
    let text = sidecar?.text,
      source: "sidecar" | "embedded" | "none" = sidecar ? "sidecar" : "none";
    if (text === undefined && metadata.hasSubtitles) {
      const subtitlePath = join(directory, "subtitles.srt");
      await runVideoCommand(execution, "ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        ...LOCAL_VIDEO_INPUT_ARGUMENTS,
        "-i",
        snapshot,
        "-map",
        "0:s:0",
        "-f",
        "srt",
        "-fs",
        String(VIDEO_INSPECT_MAX_SUBTITLE_BYTES + 1),
        "-y",
        subtitlePath,
      ]);
      text = (
        await boundedRead(subtitlePath, VIDEO_INSPECT_MAX_SUBTITLE_BYTES, execution.signal)
      ).toString("utf8");
      source = "embedded";
    }
    const segments = parseVideoSubtitles(text ?? "").filter(
      (segment) => segment.end > start && segment.start < end,
    );
    return {
      frames: [],
      sampleTimes: [],
      transcript: segments.slice(0, 500),
      transcriptSource: source,
      truncated: segments.length > 500,
    };
  }
  const count =
    request.count ?? (request.action === "motion" ? 6 : request.action === "storyboard" ? 9 : 4);
  const requestedTimes = request.timestamps ?? videoFrameTimes(start, end, count);
  const frames: VideoProcessorResult["frames"] = [];
  const sampleTimes: number[] = [];
  const files: string[] = [];
  let bytes = 0;
  for (const [index, timestamp] of requestedTimes.entries()) {
    const file = join(directory, `frame-${String(index + 1).padStart(3, "0")}.jpg`);
    const crop = request.crop;
    const filters = crop
      ? [`crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y}`]
      : [];
    filters.push("scale=2048:2048:force_original_aspect_ratio=decrease", "showinfo");
    const result = await runVideoCommand(execution, "ffmpeg", [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "info",
      "-copyts",
      // copyts 本身保留容器初始 PTS；以媒体起点为零才能和用户请求秒数同轴。
      "-start_at_zero",
      "-ss",
      String(timestamp),
      ...LOCAL_VIDEO_INPUT_ARGUMENTS,
      "-i",
      snapshot,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      filters.join(","),
      "-q:v",
      "3",
      "-y",
      file,
    ]);
    // showinfo 对很小的 PTS 使用科学计数法；旧字符类会把 1e-7 错读成 1 秒。
    const pts = /\bpts_time:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/iu.exec(result.stderr);
    const actual = Number(pts?.[1]);
    if (!pts || !Number.isFinite(actual) || actual < timestamp - 0.001 || actual >= end)
      throw new VideoProcessorPortError(
        "process_failed",
        "Decoder did not provide a valid source frame timestamp.",
      );
    const data = await boundedRead(file, VIDEO_INSPECT_MAX_FRAME_BYTES, execution.signal);
    bytes += data.byteLength;
    if (bytes > VIDEO_INSPECT_MAX_IMAGE_BYTES)
      throw new VideoProcessorPortError(
        "too_large",
        "Extracted images exceed the 4 MiB request budget.",
      );
    frames.push({
      data,
      mediaType: "image/jpeg",
      timestamp: actual,
      requestedTimestamp: timestamp,
    });
    sampleTimes.push(actual);
    files.push(file);
  }
  if (request.action === "storyboard") {
    const output = join(directory, "storyboard.jpg");
    const columns = Math.ceil(Math.sqrt(frames.length)),
      rows = Math.ceil(frames.length / columns);
    await runVideoCommand(execution, "ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-framerate",
      "1",
      "-i",
      join(directory, "frame-%03d.jpg"),
      "-vf",
      `scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:black,tile=${columns}x${rows}`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-y",
      output,
    ]);
    return {
      frames: [
        {
          data: await boundedRead(output, VIDEO_INSPECT_MAX_FRAME_BYTES, execution.signal),
          mediaType: "image/jpeg",
          timestamp: sampleTimes[0]!,
          requestedTimestamp: requestedTimes[0]!,
          storyboard: true,
        },
      ],
      sampleTimes,
      requestedSampleTimes: requestedTimes,
      truncated: false,
    };
  }
  if (request.action !== "motion")
    return { frames, sampleTimes, requestedSampleTimes: requestedTimes, truncated: false };
  const rawFrames: Uint8Array[] = [];
  for (const [index, file] of files.entries()) {
    const output = join(directory, `motion-${index}.rgb`);
    await runVideoCommand(execution, "ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=160:90",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-y",
      output,
    ]);
    rawFrames.push(await boundedRead(output, 160 * 90 * 3, execution.signal));
  }
  const sampleInterval = (sampleTimes.at(-1)! - sampleTimes[0]!) / (sampleTimes.length - 1);
  const frameGap = metadata.frameRate ? sampleInterval * metadata.frameRate : undefined;
  return {
    frames,
    sampleTimes,
    requestedSampleTimes: requestedTimes,
    truncated: false,
    motion: {
      ...measureVideoMotion(rawFrames, 160, 90),
      sampleInterval,
      ...(frameGap === undefined ? {} : { frameGap }),
      sampling: frameGap !== undefined && frameGap <= 4 ? "near-continuous" : "sparse",
    },
  };
}

async function boundedRead(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  assertVideoNotCancelled(signal);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size === 0)
    throw new VideoProcessorPortError(
      "process_failed",
      "Video processing produced no usable output.",
    );
  if (metadata.size > maxBytes)
    throw new VideoProcessorPortError("too_large", "Video output exceeds its byte budget.");
  const data = await readFile(path, { signal });
  if (data.byteLength > maxBytes)
    throw new VideoProcessorPortError("too_large", "Video output exceeds its byte budget.");
  return data;
}
