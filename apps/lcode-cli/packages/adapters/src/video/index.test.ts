import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRootTraceContext,
  VideoProcessorPortError,
  type ExecutionPort,
  type ExecutionRequest,
  type ExecutionResult,
} from "@lcode/contracts";
import { createNodeVideoProcessorAdapter } from "./index.js";

function settled(stdout = "", stderr = "", failed = false): ExecutionResult {
  return {
    status: failed ? "spawn_error" : "completed",
    exitCode: failed ? undefined : 0,
    stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false },
    stderr: { text: stderr, bytes: Buffer.byteLength(stderr), truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "video-port-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "含空格 video.mp4");
  await writeFile(path, "version-one");
  return { directory, path };
}

function fakeExecution(onMetadata?: () => Promise<void>, missingFfmpeg = false) {
  let metadataCalls = 0;
  const requests: ExecutionRequest[] = [];
  const port = {
    run: async (request: ExecutionRequest) => {
      requests.push(request);
      assert.equal(request.command.mode, "argv");
      if (request.command.mode !== "argv") throw new Error("argv required");
      const args = request.command.args ?? [];
      if (args[0] === "-version")
        return settled(
          `${request.command.file} version fixture`,
          "",
          missingFfmpeg && request.command.file === "ffmpeg",
        );
      if (request.command.file === "ffprobe") {
        metadataCalls++;
        await onMetadata?.();
        return settled(
          JSON.stringify({
            format: { duration: "3" },
            streams: [
              { codec_type: "video", width: 640, height: 360, avg_frame_rate: "30/1" },
              { codec_type: "subtitle" },
              { codec_type: "audio" },
            ],
          }),
        );
      }
      const output = args.at(-1)!;
      if (args.includes("srt"))
        await writeFile(output, "1\n00:00:01,000 --> 00:00:02,000\nembedded");
      else if (args.includes("rawvideo")) await writeFile(output, new Uint8Array(160 * 90 * 3));
      else await writeFile(output, new Uint8Array([255, 216, 255, 217]));
      const time = args.includes("-ss") ? args[args.indexOf("-ss") + 1] : "0";
      return settled("", `showinfo pts_time:${time}`);
    },
  } as unknown as ExecutionPort;
  return { port, requests, metadataCalls: () => metadataCalls };
}

test("cache is content-versioned, identity-isolated, copied and temporary files are cleaned", async (t) => {
  const { directory, path } = await fixture(t),
    fake = fakeExecution();
  const port = createNodeVideoProcessorAdapter({ executionPort: fake.port, tempRoot: directory });
  const request = {
    file_path: path,
    action: "frames" as const,
    timestamps: [0.5],
    workspaceKey: "remote:a",
    trace: createRootTraceContext(),
  };
  const first = await port.process(request);
  assert.deepEqual(first.sampleTimes, [0.5]);
  first.frames[0]!.data[0] = 0;
  assert.equal((await port.process(request)).frames[0]!.data[0], 255);
  assert.equal(fake.metadataCalls(), 1);
  await port.process({ ...request, workspaceKey: "remote:b" });
  assert.equal(fake.metadataCalls(), 2);
  await writeFile(path, "version-two");
  assert.notEqual((await port.process(request)).sourceSha256, first.sourceSha256);
  assert.equal(fake.metadataCalls(), 3);
  assert.deepEqual(await readdir(directory), ["含空格 video.mp4"]);
});

test("source replacement during processing is stale and never cached", async (t) => {
  const { directory, path } = await fixture(t),
    fake = fakeExecution(() => writeFile(path, "replaced"));
  const port = createNodeVideoProcessorAdapter({ executionPort: fake.port, tempRoot: directory });
  const request = {
    file_path: path,
    action: "inspect" as const,
    workspaceKey: directory,
    trace: createRootTraceContext(),
  };
  await assert.rejects(
    port.process(request),
    (error) => error instanceof VideoProcessorPortError && error.code === "stale",
  );
  assert.deepEqual(await readdir(directory), ["含空格 video.mp4"]);
});

test("missing FFmpeg is unavailable; invalid ranges are not extracted", async (t) => {
  const { directory, path } = await fixture(t),
    fake = fakeExecution(undefined, true);
  const port = createNodeVideoProcessorAdapter({ executionPort: fake.port, tempRoot: directory });
  const request = {
    file_path: path,
    action: "frames" as const,
    workspaceKey: directory,
    trace: createRootTraceContext(),
  };
  await assert.rejects(
    port.process(request),
    (error) => error instanceof VideoProcessorPortError && error.code === "unavailable",
  );
  assert.equal((await port.process({ ...request, action: "inspect" })).metadata.hasAudio, true);
  const ready = createNodeVideoProcessorAdapter({
    executionPort: fakeExecution().port,
    tempRoot: directory,
  });
  await assert.rejects(
    ready.process({ ...request, timestamps: [3] }),
    (error) => error instanceof VideoProcessorPortError && error.code === "invalid_request",
  );
});

test("cancellation propagates to execution and releases temporary snapshot", async (t) => {
  const { directory, path } = await fixture(t);
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const port = createNodeVideoProcessorAdapter({
    tempRoot: directory,
    executionPort: {
      run: async (_request: ExecutionRequest, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        controller.abort();
        return { ...settled(), status: "cancelled", cancelled: true };
      },
    } as unknown as ExecutionPort,
  });
  await assert.rejects(
    port.process(
      {
        file_path: path,
        action: "inspect",
        workspaceKey: directory,
        trace: createRootTraceContext(),
      },
      { signal: controller.signal },
    ),
    (error) => error instanceof VideoProcessorPortError && error.code === "cancelled",
  );
  assert.equal(signal, controller.signal);
  assert.deepEqual(await readdir(directory), ["含空格 video.mp4"]);
});

test("storyboard, motion and subtitles follow bounded samples and source precedence", async (t) => {
  const { directory, path } = await fixture(t),
    fake = fakeExecution();
  const port = createNodeVideoProcessorAdapter({ executionPort: fake.port, tempRoot: directory });
  const request = { file_path: path, workspaceKey: directory, trace: createRootTraceContext() };
  const storyboard = await port.process({ ...request, action: "storyboard", count: 12 });
  assert.equal(storyboard.frames.length, 1);
  assert.equal(storyboard.sampleTimes.length, 12);
  assert.equal(storyboard.frames[0]!.storyboard, true);
  const motion = await port.process({ ...request, action: "motion", count: 3 });
  assert.deepEqual(motion.motion?.changeRatios, [0, 0]);
  assert.equal(motion.motion?.sampling, "sparse");
  const embedded = await port.process({ ...request, action: "transcript" });
  assert.equal(embedded.transcriptSource, "embedded");
  assert.equal(embedded.transcript?.[0]?.text, "embedded");
  await writeFile(path.slice(0, -4) + ".vtt", "WEBVTT\n\n00:01.000 --> 00:02.000\n旁挂");
  const sidecar = await port.process({ ...request, action: "transcript", start: 2 });
  assert.equal(sidecar.transcriptSource, "sidecar");
  assert.deepEqual(sidecar.transcript, []);
});
