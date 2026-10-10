import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const VIDEO_INSPECT_TOOL_NAME = "VideoInspect";
export const VIDEO_INSPECT_MAX_FRAMES = 12;
export const VIDEO_INSPECT_MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const VIDEO_INSPECT_MAX_FRAME_BYTES = 1024 * 1024;
export const VIDEO_INSPECT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const VIDEO_INSPECT_MAX_SUBTITLE_BYTES = 64 * 1024;
export const VIDEO_INSPECT_TIMEOUT_MS = 120_000;

export const VideoCropSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .strict()
  .refine(
    (crop) => crop.x + crop.width <= 1 && crop.y + crop.height <= 1,
    "Crop must stay within the frame.",
  );
export type VideoCrop = z.infer<typeof VideoCropSchema>;

export const VideoInspectInputSchema = z
  .object({
    file_path: z
      .string()
      .min(1)
      .describe("Absolute path to a local video in the target execution environment."),
    action: z.enum(["inspect", "frames", "storyboard", "motion", "transcript"]).default("inspect"),
    start: z.number().finite().nonnegative().optional(),
    end: z.number().finite().positive().optional(),
    timestamps: z
      .array(z.number().finite().nonnegative())
      .min(1)
      .max(VIDEO_INSPECT_MAX_FRAMES)
      .optional(),
    count: z.number().int().min(1).max(VIDEO_INSPECT_MAX_FRAMES).optional(),
    crop: VideoCropSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (input.end !== undefined && input.end <= (input.start ?? 0))
      fail("end must be greater than start.");
    if (
      input.timestamps &&
      (input.action !== "frames" ||
        input.start !== undefined ||
        input.end !== undefined ||
        input.count !== undefined)
    )
      fail("timestamps require frames without start, end or count.");
    if (input.crop && (input.action === "inspect" || input.action === "transcript"))
      fail("crop requires an image action.");
    if (input.count !== undefined && (input.action === "inspect" || input.action === "transcript"))
      fail("count requires an image action.");
    if (input.action === "motion" && input.count === 1)
      fail("motion requires at least two samples.");
  });
export type VideoInspectInput = z.infer<typeof VideoInspectInputSchema>;
export const VideoInspectInputJsonSchema = toToolJsonSchema(VideoInspectInputSchema);

export const VideoMetadataSchema = z
  .object({
    duration: z.number().finite().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: z.number().finite().positive().optional(),
    hasAudio: z.boolean(),
    hasSubtitles: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
export const VideoTranscriptSegmentSchema = z
  .object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    text: z.string(),
  })
  .strict();
export type VideoTranscriptSegment = z.infer<typeof VideoTranscriptSegmentSchema>;
export const VideoMotionSchema = z
  .object({
    changeRatios: z.array(z.number().min(0).max(1)).max(VIDEO_INSPECT_MAX_FRAMES - 1),
    changedRegion: VideoCropSchema.optional(),
    sampleInterval: z.number().finite().nonnegative(),
    frameGap: z.number().finite().nonnegative().optional(),
    sampling: z.enum(["near-continuous", "sparse"]),
  })
  .strict();

export const VideoInspectOutputSchema = z
  .object({
    action: z.enum(["inspect", "frames", "storyboard", "motion", "transcript"]),
    filePath: z.string(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    processorVersion: z.string(),
    metadata: VideoMetadataSchema,
    sampleTimes: z.array(z.number().finite().nonnegative()).max(VIDEO_INSPECT_MAX_FRAMES),
    requestedSampleTimes: z
      .array(z.number().finite().nonnegative())
      .max(VIDEO_INSPECT_MAX_FRAMES)
      .optional(),
    frames: z
      .array(
        z
          .object({
            timestamp: z.number().finite().nonnegative(),
            requestedTimestamp: z.number().finite().nonnegative().optional(),
            mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
            base64: z.string(),
            bytes: z.number().int().nonnegative(),
            storyboard: z.boolean().optional(),
          })
          .strict(),
      )
      .max(VIDEO_INSPECT_MAX_FRAMES),
    transcript: z.array(VideoTranscriptSegmentSchema).max(500).optional(),
    transcriptSource: z.enum(["sidecar", "embedded", "none"]).optional(),
    truncated: z.boolean(),
    motion: VideoMotionSchema.optional(),
  })
  .strict();
export type VideoInspectOutput = z.infer<typeof VideoInspectOutputSchema>;
export const VideoInspectOutputJsonSchema = toToolJsonSchema(VideoInspectOutputSchema);
