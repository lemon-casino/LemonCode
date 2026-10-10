import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  VIDEO_INSPECT_MAX_INPUT_BYTES,
  VideoProcessorPortError,
  type ExecutionPort,
  type TraceContext,
} from "@lcode/contracts";

export interface VideoExecution {
  executionPort: ExecutionPort;
  ffmpeg?: string;
  ffprobe?: string;
  signal?: AbortSignal;
  deadline: number;
  trace: TraceContext;
  cwd?: string;
}

export function assertVideoNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new VideoProcessorPortError("cancelled", "Video inspection was cancelled.");
}

export async function runVideoCommand(
  execution: VideoExecution,
  binary: "ffmpeg" | "ffprobe",
  args: string[],
  availability = false,
): Promise<{ stdout: string; stderr: string }> {
  assertVideoNotCancelled(execution.signal);
  const remaining = execution.deadline - Date.now();
  if (remaining <= 0)
    throw new VideoProcessorPortError(
      "timeout",
      "Video inspection exceeded its processing budget.",
    );
  const result = await execution.executionPort.run(
    {
      command: { mode: "argv", file: execution[binary] ?? binary, args },
      ...(execution.cwd ? { cwd: execution.cwd } : {}),
      timeoutMs: Math.min(30_000, remaining),
      outputLimit: {
        maxInlineBytes: 128 * 1024,
        maxBufferBytes: 128 * 1024,
        persistOutput: "none",
      },
      trace: execution.trace,
    },
    execution.signal ? { signal: execution.signal } : undefined,
  );
  if (result.cancelled || execution.signal?.aborted)
    throw new VideoProcessorPortError("cancelled", "Video inspection was cancelled.");
  if (result.timedOut || result.status === "timed_out")
    throw new VideoProcessorPortError("timeout", "Video processing command timed out.");
  if (result.status !== "completed" || result.exitCode !== 0) {
    if (availability)
      throw new VideoProcessorPortError(
        "unavailable",
        `${binary} is unavailable in the target execution environment. Install it there or inject VideoProcessorPort.`,
        { cause: result.error?.cause },
      );
    throw new VideoProcessorPortError(
      "process_failed",
      `${binary} could not complete video inspection.`,
      { cause: result.error?.cause },
    );
  }
  if (result.stdout.truncated || result.stderr.truncated)
    throw new VideoProcessorPortError(
      "too_large",
      "Video command output exceeded its bounded diagnostic budget.",
    );
  return { stdout: result.stdout.text, stderr: result.stderr.text };
}

export async function videoFileDigest(
  path: string,
  signal?: AbortSignal,
  maxBytes = VIDEO_INSPECT_MAX_INPUT_BYTES,
): Promise<string> {
  assertVideoNotCancelled(signal);
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(path, { signal });
  try {
    for await (const chunk of stream) {
      assertVideoNotCancelled(signal);
      bytes += chunk.byteLength;
      if (bytes > maxBytes)
        throw new VideoProcessorPortError(
          "too_large",
          "Video source exceeded its fingerprint budget.",
        );
      hash.update(chunk);
    }
  } catch (error) {
    assertVideoNotCancelled(signal);
    if (error instanceof VideoProcessorPortError) throw error;
    throw new VideoProcessorPortError("io_error", "Could not fingerprint the video source.", {
      cause: error,
    });
  }
  return hash.digest("hex");
}
