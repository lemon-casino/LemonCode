import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import {
  VIDEO_INSPECT_MAX_INPUT_BYTES,
  VIDEO_INSPECT_TIMEOUT_MS,
  VideoInspectInputSchema,
  VideoProcessorPortError,
  type ExecutionPort,
  type VideoProcessorPort,
  type VideoProcessorRequest,
  type VideoProcessorResult,
} from "@lcode/contracts";
import {
  assertVideoNotCancelled,
  runVideoCommand,
  videoFileDigest,
  type VideoExecution,
} from "./execution.js";
import { extractVideoMedia, probeVideo } from "./media.js";
import { readVideoSidecar } from "./sidecar.js";

export interface NodeVideoProcessorOptions {
  executionPort: ExecutionPort;
  tempRoot?: string;
  ffmpeg?: string;
  ffprobe?: string;
  maxCacheBytes?: number;
}

export function createNodeVideoProcessorAdapter(
  options: NodeVideoProcessorOptions,
): VideoProcessorPort {
  return new NodeVideoProcessor(options);
}

class NodeVideoProcessor implements VideoProcessorPort {
  private readonly cache = new Map<string, { result: VideoProcessorResult; bytes: number }>();
  private cacheBytes = 0;
  private readonly cacheLimit: number;
  constructor(private readonly options: NodeVideoProcessorOptions) {
    this.cacheLimit = Math.max(
      0,
      Math.min(16 * 1024 * 1024, options.maxCacheBytes ?? 16 * 1024 * 1024),
    );
  }

  async process(
    request: VideoProcessorRequest,
    options?: { signal?: AbortSignal },
  ): Promise<VideoProcessorResult> {
    assertVideoNotCancelled(options?.signal);
    const parsed = VideoInspectInputSchema.safeParse({
      file_path: request.file_path,
      action: request.action,
      start: request.start,
      end: request.end,
      timestamps: request.timestamps,
      count: request.count,
      crop: request.crop,
    });
    if (!parsed.success || !request.workspaceKey.trim())
      throw new VideoProcessorPortError("invalid_request", "Invalid video inspection request.");
    const execution: VideoExecution = {
      ...this.options,
      deadline: Date.now() + VIDEO_INSPECT_TIMEOUT_MS,
      signal: options?.signal,
      trace: request.trace,
      cwd: request.workingDirectory,
    };
    const tempRoot = resolve(this.options.tempRoot ?? tmpdir());
    let directory: string | undefined;
    let completedResult: VideoProcessorResult | undefined;
    let cleanupFailure: unknown;
    try {
      const source = await stat(request.file_path);
      if (!source.isFile() || !source.size)
        throw new VideoProcessorPortError(
          "corrupted",
          "Video source must be a nonempty regular file.",
        );
      if (source.size > VIDEO_INSPECT_MAX_INPUT_BYTES)
        throw new VideoProcessorPortError("too_large", "Video source exceeds the 256 MiB limit.");
      directory = await mkdtemp(join(tempRoot, "lcode-video-"));
      const snapshot = join(directory, `source${extname(request.file_path)}`);
      await copyFile(request.file_path, snapshot);
      if ((await stat(snapshot)).size > VIDEO_INSPECT_MAX_INPUT_BYTES)
        throw new VideoProcessorPortError("too_large", "Video changed beyond its input budget.");
      const digest = await videoFileDigest(snapshot, execution.signal);
      const sidecar =
        request.action === "transcript"
          ? await readVideoSidecar(request.file_path, execution.signal)
          : undefined;
      const probeVersion = await runVideoCommand(execution, "ffprobe", ["-version"], true);
      let mediaVersion = "";
      if (request.action !== "inspect" && !(request.action === "transcript" && sidecar))
        mediaVersion = (await runVideoCommand(execution, "ffmpeg", ["-version"], true)).stdout;
      const processorVersion =
        "lcode-video-v1:" +
        createHash("sha256")
          .update(probeVersion.stdout + "\n" + mediaVersion)
          .digest("hex")
          .slice(0, 16);
      const key = createHash("sha256")
        .update(
          JSON.stringify({
            workspace: request.workspaceKey,
            input: parsed.data,
            digest,
            sidecar: sidecar?.digest,
            processorVersion,
          }),
        )
        .digest("hex");
      const cached = this.cache.get(key);
      let result: VideoProcessorResult;
      if (cached) {
        result = structuredClone(cached.result);
      } else {
        const metadata = await probeVideo(snapshot, (await stat(snapshot)).size, execution);
        result = {
          sourceSha256: digest,
          processorVersion,
          metadata,
          ...(await extractVideoMedia({
            request,
            metadata,
            snapshot,
            directory,
            execution,
            sidecar,
          })),
        };
      }
      // 缓存及抽帧都消费冻结副本；结算前比对真实来源，防止同路径换内容或跨帧混版本。
      const currentSidecar =
        request.action === "transcript"
          ? await readVideoSidecar(request.file_path, execution.signal)
          : undefined;
      if (
        (await videoFileDigest(request.file_path, execution.signal)) !== digest ||
        currentSidecar?.path !== sidecar?.path ||
        currentSidecar?.digest !== sidecar?.digest
      )
        throw new VideoProcessorPortError(
          "stale",
          "Video or subtitle source changed during inspection; retry with the new content.",
        );
      assertVideoNotCancelled(execution.signal);
      if (!cached) this.remember(key, result);
      completedResult = result;
    } catch (error) {
      assertVideoNotCancelled(options?.signal);
      if (error instanceof VideoProcessorPortError) throw error;
      throw new VideoProcessorPortError(
        "io_error",
        "Could not read or prepare video inspection files.",
        { cause: error },
      );
    } finally {
      // finally 只收集清理错误；原始取消/解码失败继续沿 catch 抛出，不被清理覆盖。
      if (directory)
        await cleanVideoDirectory(tempRoot, directory).catch((error) => {
          cleanupFailure = error;
        });
    }
    if (cleanupFailure)
      throw new VideoProcessorPortError("io_error", "Could not clean video temporary files.", {
        cause: cleanupFailure,
      });
    return completedResult!;
  }

  private remember(key: string, result: VideoProcessorResult): void {
    const bytes =
      result.frames.reduce((sum, frame) => sum + frame.data.byteLength, 0) +
      Buffer.byteLength(JSON.stringify({ ...result, frames: [] }));
    if (bytes > this.cacheLimit) return;
    // 同key并发结算会覆盖 Map 条目；必须先扣旧条目，不能重复累计不存在的缓存字节。
    const previous = this.cache.get(key);
    if (previous) {
      this.cacheBytes -= previous.bytes;
      this.cache.delete(key);
    }
    while (this.cacheBytes + bytes > this.cacheLimit && this.cache.size) {
      const firstKey = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(firstKey)!.bytes;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { bytes, result: structuredClone(result) });
    this.cacheBytes += bytes;
  }
}

async function cleanVideoDirectory(tempRoot: string, directory: string): Promise<void> {
  const inside = relative(tempRoot, resolve(directory));
  if (
    !inside.startsWith("lcode-video-") ||
    inside.includes("..") ||
    inside.includes("\\") ||
    inside.includes("/")
  )
    throw new Error("Invalid video temporary cleanup boundary.");
  await rm(directory, { recursive: true, force: true });
}
