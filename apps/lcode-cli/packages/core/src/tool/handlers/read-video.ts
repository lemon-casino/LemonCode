// Read 工具的视频分支：无转码/压缩依赖（CLI 不引 ffmpeg），只读 base64 + 大小校验。
// wire 侧由 adapter 把 video block 转成 video_url / anthropic video block（见 transform.ts 与两个 AI SDK patch）。
import {
  CoreErrorType,
  READ_VIDEO_MAX_INPUT_BYTES,
  createCoreError,
  isFileSystemPortError,
  type ReadVideoOutput,
  type TraceContext,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import type { VideoInputMimeType } from "../../runtime/helpers/attachment-video.js";

export async function readVideoFile(
  filePath: string,
  mimeType: VideoInputMimeType,
  context: ToolExecutionContext,
): Promise<ReadVideoOutput> {
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for Read tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: false,
      },
    );
  }

  const trace = createToolTrace(context);
  try {
    const read = await fileSystemPort.readBinaryFile(
      {
        path: filePath,
        maxBytes: READ_VIDEO_MAX_INPUT_BYTES,
        trace,
      },
      { signal: context.abortSignal },
    );
    if (read.bytesRead === 0) {
      // 空 video 会生成空 data URL，随后被 adapter 丢弃，但 Read 已宣告成功。
      throw createCoreError(CoreErrorType.ToolExecutionFailed, "Cannot read an empty video file.", {
        context: {
          code: "read_video_input_empty",
          filePath,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    return {
      type: "video",
      base64: Buffer.from(read.content).toString("base64"),
      mimeType,
      originalSize: read.sizeBytes,
    };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "too_large") {
      throw createCoreError(CoreErrorType.ToolExecutionFailed, error.message, {
        cause: error,
        context: {
          code: "read_video_input_too_large",
          filePath,
          maxBytes: READ_VIDEO_MAX_INPUT_BYTES,
          toolCallId: context.toolCallId,
          toolName: "Read",
        },
        recoverable: true,
      });
    }
    throw error;
  }
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as unknown as TraceContext;
}
