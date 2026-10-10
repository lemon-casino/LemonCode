import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  type VideoProcessorPort,
  type VideoProcessorRequest,
  type VideoProcessorResult,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { videoInspectToolEntry } from "./video-inspect.js";

const result: VideoProcessorResult = {
  sourceSha256: "a".repeat(64),
  processorVersion: "test",
  metadata: {
    duration: 3,
    width: 10,
    height: 10,
    hasAudio: false,
    hasSubtitles: false,
    sizeBytes: 1,
  },
  sampleTimes: [],
  frames: [],
  truncated: false,
};
function context(port?: VideoProcessorPort): ToolExecutionContext {
  return {
    toolCallId: "video-call",
    abortSignal: new AbortController().signal,
    traceId: createRootTraceContext().traceId,
    workingDirectory: resolve("workspace"),
    workspaceRoot: resolve("workspace"),
    workspaceIdentity: "remote:identity",
    videoProcessorPort: port,
  } as ToolExecutionContext;
}

test("inspection uses identity fallback and requires no image capability", async () => {
  let request: VideoProcessorRequest | undefined;
  const ctx = context({
    process: async (value) => {
      request = value;
      return result;
    },
  });
  const output = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4") },
    ctx,
  );
  assert.equal(request?.workspaceKey, "remote:identity");
  assert.equal(
    (request as VideoProcessorRequest & { workingDirectory?: string })?.workingDirectory,
    ctx.workingDirectory,
  );
  assert.equal((output as { action: string }).action, "inspect");
  ctx.workspaceIdentity = "  ";
  await videoInspectToolEntry.handler({ file_path: resolve("workspace/video.mp4") }, ctx);
  assert.equal(request?.workspaceKey, ctx.workspaceRoot);
});

test("absent media capability and text-only images fail before executing", async () => {
  const missing = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4") },
    context(),
  );
  assert.equal((missing as { result: boolean }).result, false);
  let calls = 0;
  const ctx = context({
    process: async () => {
      calls++;
      return result;
    },
  });
  ctx.model = {
    properties: { inputFormat: { supportsImage: false } },
  } as ToolExecutionContext["model"];
  const output = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4"), action: "frames" },
    ctx,
  );
  assert.equal((output as { result: boolean }).result, false);
  assert.equal(calls, 0);
});

test("late success after cancellation cannot become a committed result", async () => {
  const controller = new AbortController();
  const ctx = context({
    process: async () => {
      controller.abort();
      return result;
    },
  });
  ctx.abortSignal = controller.signal;
  await assert.rejects(
    videoInspectToolEntry.handler({ file_path: resolve("workspace/video.mp4") }, ctx),
    /cancelled/iu,
  );
});

test("frames are image-budgeted and format as timestamped recoverable media", async () => {
  const ctx = context({
    process: async () => ({
      ...result,
      sampleTimes: [0.5],
      frames: [{ data: new Uint8Array([1, 2]), mediaType: "image/jpeg", timestamp: 0.5 }],
    }),
  });
  ctx.imageProcessorPort = {
    prepareForModel: async (request) => ({
      data: request.data,
      mediaType: "image/jpeg",
      resized: false,
      compressed: false,
      originalSizeBytes: 2,
      transformedSizeBytes: 2,
      strategy: "original",
    }),
  } as ToolExecutionContext["imageProcessorPort"];
  const output = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4"), action: "frames", timestamps: [0.5] },
    ctx,
  );
  const content = videoInspectToolEntry.formatModelContent!(output);
  assert.ok(Array.isArray(content));
  assert.equal(content[1]?.type, "image");
  assert.match(content[0]?.type === "text" ? content[0].text : "", /0\.5/u);
});

test("injected processor byte budgets reject before decoding image or formatting subtitle text", async () => {
  let conversions = 0;
  const oversizedFrame = {
    ...result,
    sampleTimes: [0],
    frames: [
      { data: new Uint8Array(1024 * 1024 + 1), mediaType: "image/jpeg" as const, timestamp: 0 },
    ],
  };
  const ctx = context({ process: async () => oversizedFrame });
  ctx.imageProcessorPort = {
    prepareForModel: async () => {
      conversions++;
      throw new Error("must not decode oversized input");
    },
  } as ToolExecutionContext["imageProcessorPort"];
  const frameFailure = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4"), action: "frames" },
    ctx,
  );
  assert.equal((frameFailure as { errorCode: number }).errorCode, 8104);
  assert.equal(conversions, 0);
  ctx.videoProcessorPort = {
    process: async () => ({
      ...result,
      transcript: [{ start: 0, end: 1, text: "中".repeat(23000) }],
      transcriptSource: "sidecar",
    }),
  };
  const textFailure = await videoInspectToolEntry.handler(
    { file_path: resolve("workspace/video.mp4"), action: "transcript" },
    ctx,
  );
  assert.equal((textFailure as { errorCode: number }).errorCode, 8104);
});
