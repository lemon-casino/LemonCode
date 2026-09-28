import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRecordingArtifact, BrowserViewportSize } from "@lcode/shared";

export interface BrowserWebmRecorderFactoryInput {
  outputPath: string;
  targetFrame: unknown;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
}

export interface BrowserWebmRecorderSession {
  /** 停止 Chromium MediaRecorder，并等待最后一个 WebM chunk 安全写盘。 */
  stop(): Promise<void>;
  /** 中止录制并关闭 renderer/stream/文件句柄；必须可重复调用。 */
  cancel(): Promise<void>;
}

export type BrowserWebmRecorderFactory = (
  input: BrowserWebmRecorderFactoryInput,
) => Promise<BrowserWebmRecorderSession>;

function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * 编排一次 IAB WebM 录制。具体媒体能力由 Desktop main 注入，纯编排层不依赖 Electron，
 * 便于验证失败清理与 artifact 合同，也避免 Service/Host 反向引用 Runtime 实现。
 */
export async function recordBrowserVideo(input: {
  targetFrame: unknown;
  tempRoot: string;
  recordingId: string;
  viewport: BrowserViewportSize;
  fps: number;
  signal: AbortSignal;
  executeScenario(): Promise<void>;
  onPhase?(phase: "capturing" | "finalizing"): void;
  onCaptureComplete?(): void;
  createRecorder: BrowserWebmRecorderFactory;
  now?: () => number;
}): Promise<BrowserRecordingArtifact> {
  const outputPath = join(input.tempRoot, `${input.recordingId}.webm`);
  const now = input.now ?? Date.now;
  let recorder: BrowserWebmRecorderSession | undefined;
  let completed = false;

  try {
    throwIfAborted(input.signal);
    recorder = await input.createRecorder({
      outputPath,
      targetFrame: input.targetFrame,
      viewport: input.viewport,
      fps: input.fps,
      signal: input.signal,
    });
    throwIfAborted(input.signal);

    const captureStartedAt = now();
    input.onPhase?.("capturing");
    await input.executeScenario();
    throwIfAborted(input.signal);
    const durationMs = Math.max(0, Math.round(now() - captureStartedAt));

    // 页面取景已经结束：先释放 background surface watchdog，再等待 recorder flush 尾块。
    input.onCaptureComplete?.();
    input.onPhase?.("finalizing");
    await recorder.stop();
    throwIfAborted(input.signal);

    const artifactStat = await stat(outputPath);
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      throw new Error("Browser recording produced an empty WebM artifact");
    }
    completed = true;
    return {
      path: outputPath,
      mimeType: "video/webm",
      width: input.viewport.width,
      height: input.viewport.height,
      fps: input.fps,
      durationMs,
      frameCount: Math.max(1, Math.round((durationMs / 1_000) * input.fps)),
    };
  } finally {
    if (!completed) {
      // MediaRecorder 失败或场景动作抛错时，残留的 EBML 头看起来像视频但不可播放；
      // 必须同时关闭 recorder 并删除半成品，避免 status 暴露伪 artifact。
      await recorder?.cancel().catch(() => undefined);
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }
}
