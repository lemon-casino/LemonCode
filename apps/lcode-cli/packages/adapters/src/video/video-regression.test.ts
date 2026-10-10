import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const settled = (stdout = "", stderr = ""): ExecutionResult => ({
  status: "completed",
  exitCode: 0,
  stdout: { text: stdout, bytes: Buffer.byteLength(stdout), truncated: false },
  stderr: { text: stderr, bytes: Buffer.byteLength(stderr), truncated: false },
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  startedAt: new Date(),
  completedAt: new Date(),
});
async function fixture(
  t: test.TestContext,
  onProbe?: () => Promise<void>,
  frameTime?: (args: string[]) => number,
) {
  const directory = await mkdtemp(join(tmpdir(), "video-regression-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "中文 video.mp4");
  await writeFile(path, "video-content");
  const requests: ExecutionRequest[] = [];
  let probes = 0;
  const execution = {
    run: async (request: ExecutionRequest) => {
      requests.push(request);
      assert.equal(request.command.mode, "argv");
      if (request.command.mode !== "argv") throw new Error("argv required");
      const args = request.command.args ?? [];
      if (args[0] === "-version") return settled("version fixture\nbuild fixture");
      if (request.command.file === "ffprobe") {
        probes++;
        await onProbe?.();
        return settled(
          JSON.stringify({
            format: { duration: "3", start_time: "2" },
            streams: [
              { codec_type: "video", width: 64, height: 36, avg_frame_rate: "30/1" },
              { codec_type: "subtitle" },
            ],
          }),
        );
      }
      await writeFile(
        args.at(-1)!,
        args.includes("srt")
          ? "1\n00:00:00,000 --> 00:00:01,000\nembedded"
          : new Uint8Array([255, 216, 255, 217]),
      );
      return settled(
        "",
        `showinfo pts_time:${frameTime?.(args) ?? Number(args[args.indexOf("-ss") + 1] ?? 0)}`,
      );
    },
  } as unknown as ExecutionPort;
  return {
    directory,
    path,
    execution,
    requests,
    probes: () => probes,
    request: {
      file_path: path,
      workspaceKey: directory,
      workingDirectory: directory,
      trace: createRootTraceContext(),
    },
  };
}

test("all video commands preserve target cwd and normalize source timestamps with explicit stream selection", async (t) => {
  const h = await fixture(t, undefined, (args) =>
    args.includes("-start_at_zero") ? 0.533 : 2.533,
  );
  const result = await createNodeVideoProcessorAdapter({
    executionPort: h.execution,
    tempRoot: h.directory,
  }).process({ ...h.request, action: "frames", timestamps: [0.5] });
  assert.deepEqual(result.sampleTimes, [0.533]);
  assert.equal((result.frames[0] as { requestedTimestamp?: number }).requestedTimestamp, 0.5);
  assert.ok(h.requests.every((request) => request.cwd === h.directory));
  const frame = h.requests.find(
    (request) => request.command.mode === "argv" && request.command.args?.includes("-ss"),
  )!;
  assert.equal(frame.command.mode, "argv");
  if (frame.command.mode === "argv")
    assert.equal(frame.command.args?.[frame.command.args.indexOf("-map") + 1], "0:v:0");
});

test("a decoded frame outside the requested exclusive interval is unavailable", async (t) => {
  const h = await fixture(t, undefined, () => 2);
  await assert.rejects(
    createNodeVideoProcessorAdapter({ executionPort: h.execution, tempRoot: h.directory }).process({
      ...h.request,
      action: "frames",
      start: 1,
      end: 1.5,
      count: 1,
    }),
    (error) => error instanceof VideoProcessorPortError && error.code === "process_failed",
  );
});

test("decoder scientific timestamps preserve sub-millisecond source positions", async (t) => {
  const h = await fixture(t, undefined, () => 1e-7);
  const output = await createNodeVideoProcessorAdapter({
    executionPort: h.execution,
    tempRoot: h.directory,
  }).process({ ...h.request, action: "frames", timestamps: [0] });
  assert.deepEqual(output.sampleTimes, [1e-7]);
});

for (const initial of ["none", "vtt"] as const)
  test(`subtitle source precedence is rechecked when ${initial} gains a higher-priority sidecar`, async (t) => {
    let directory = "";
    const h = await fixture(t, () =>
      writeFile(join(directory, "中文 video.srt"), "1\n00:00:00,000 --> 00:00:01,000\nnew sidecar"),
    );
    directory = h.directory;
    if (initial === "vtt")
      await writeFile(
        join(directory, "中文 video.vtt"),
        "WEBVTT\n\n00:00.000 --> 00:01.000\nold sidecar",
      );
    await assert.rejects(
      createNodeVideoProcessorAdapter({
        executionPort: h.execution,
        tempRoot: h.directory,
      }).process({ ...h.request, action: "transcript" }),
      (error) => error instanceof VideoProcessorPortError && error.code === "stale",
    );
  });

test("concurrent replacement of a cache key accounts its bytes once", async (t) => {
  const h = await fixture(t);
  const one = await createNodeVideoProcessorAdapter({
    executionPort: h.execution,
    tempRoot: h.directory,
    maxCacheBytes: 0,
  }).process({ ...h.request, action: "inspect" });
  const bytes = Buffer.byteLength(JSON.stringify({ ...one, frames: [] }));
  const port = createNodeVideoProcessorAdapter({
    executionPort: h.execution,
    tempRoot: h.directory,
    maxCacheBytes: bytes * 2 + 16,
  });
  const request = { ...h.request, action: "inspect" as const };
  await Promise.all([port.process(request), port.process(request)]);
  await port.process({ ...request, workspaceKey: "other-identity" });
  const probes = h.probes();
  await port.process(request);
  assert.equal(h.probes(), probes);
});
