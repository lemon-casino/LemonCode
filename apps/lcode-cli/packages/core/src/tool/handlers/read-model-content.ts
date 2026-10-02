import {
  ReadOutputSchema,
  type ReadImageOutput,
  type ReadVideoOutput,
  type ModelMessageContent,
  type ReadOutput,
} from "@lcode/contracts";
import { formatReadTextOutput } from "./read-text.js";
import { formatReadPdfOutput, formatReadPdfPagesOutput } from "./read-pdf.js";

const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";

export function formatReadModelContent(output: unknown): ModelMessageContent {
  const parsed = ReadOutputSchema.safeParse(output);
  if (!parsed.success) {
    return stringifyReadOutputFallback(output);
  }

  return formatReadOutput(parsed.data);
}

function formatReadOutput(output: ReadOutput): ModelMessageContent {
  switch (output.type) {
    case "text":
      return formatReadTextOutput(output);
    case "file_unchanged":
      return FILE_UNCHANGED_STUB;
    case "image":
      return formatReadImageOutput(output);
    case "video":
      return formatReadVideoOutput(output);
    case "pdf":
      return formatReadPdfOutput(output);
    case "parts":
      return formatReadPdfPagesOutput(output);
    case "notebook":
      return stringifyReadOutputFallback(output);
  }
}

function formatReadImageOutput(output: ReadImageOutput): ModelMessageContent {
  const imageBlock = {
    type: "image" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-image",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read image",
      sizeBytes: output.originalSize,
    },
  };
  // 尺寸提示拼进 tool result 会让 provider-visible content 随是否缩放而改变；
  // 图片结果只保留媒体 block，dimensions 继续留在结构化 output 供 UI 和调试使用。
  return [imageBlock];
}

// 与图片同构：tool result 只保留媒体 block；OpenAI 系 provider 由
// tool-result-media-projection 拆成后置 user part（AI SDK tool result 无 video part 变体）。
function formatReadVideoOutput(output: ReadVideoOutput): ModelMessageContent {
  const videoBlock = {
    type: "video" as const,
    mediaType: output.mimeType,
    dataUrl: `data:${output.mimeType};base64,${output.base64}`,
    source: {
      id: "read-video",
      kind: "inline" as const,
      mimeType: output.mimeType,
      placeholder: "Read video",
      sizeBytes: output.originalSize,
    },
  };
  return [videoBlock];
}

function stringifyReadOutputFallback(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output) ?? "";
}
