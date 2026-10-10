import type { TraceContext } from "../tracing/tracer.js";
import type {
  VideoInspectInput,
  VideoMetadata,
  VideoMotionSchema,
  VideoTranscriptSegment,
} from "../tools/video-inspect.js";
import type { z } from "zod";

export type VideoProcessorErrorCode =
  | "unavailable"
  | "invalid_request"
  | "corrupted"
  | "too_large"
  | "io_error"
  | "process_failed"
  | "cancelled"
  | "timeout"
  | "stale";
export class VideoProcessorPortError extends Error {
  constructor(
    readonly code: VideoProcessorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoProcessorPortError";
  }
}
export interface VideoProcessorRequest extends VideoInspectInput {
  workspaceKey: string;
  /** Target session cwd selects the existing managed execution environment. */
  workingDirectory?: string;
  trace: TraceContext;
}
export interface VideoProcessorFrame {
  data: Uint8Array;
  mediaType: "image/jpeg";
  timestamp: number;
  requestedTimestamp?: number;
  storyboard?: boolean;
}
export interface VideoProcessorResult {
  sourceSha256: string;
  processorVersion: string;
  metadata: VideoMetadata;
  sampleTimes: number[];
  requestedSampleTimes?: number[];
  frames: VideoProcessorFrame[];
  transcript?: VideoTranscriptSegment[];
  transcriptSource?: "sidecar" | "embedded" | "none";
  truncated: boolean;
  motion?: z.infer<typeof VideoMotionSchema>;
}
export interface VideoProcessorPort {
  process(
    request: VideoProcessorRequest,
    options?: { signal?: AbortSignal },
  ): Promise<VideoProcessorResult>;
}
