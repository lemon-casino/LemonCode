import {
  BashOutputSchema,
  parseImageDataUrl,
  type BashOutput,
  type ModelMessageContent,
} from "@lcode/contracts";
import { formatPersistedOutputEnvelope } from "../result-persistence-format.js";
import { isBashProviderErrorStatus } from "./bash-semantics.js";

const MODEL_RESULT_PREVIEW_CHARS = 2_000;
const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;
const READ_TOOL_NAME = "Read";

export function formatBashModelContent(output: unknown): ModelMessageContent {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return stringifyFallback(output);

  const result = parsed.data;
  if (Array.isArray(result.structuredContent) && result.structuredContent.length > 0) {
    return result.structuredContent as ModelMessageContent;
  }

  // Bash 失败以结果对象返回；模型可见的错误结果应保持为纯文本。
  if (isBashOutputProviderError(result)) {
    return formatProviderErrorContent(result);
  }

  const imageContent = maybeImageContent(result);
  if (imageContent) return imageContent;

  return formatTextContentForModel(result);
}

export function formatPersistedBashModelContent(input: {
  content: string;
  output: unknown;
  persistedPath: string;
  originalBytes: number;
}): ModelMessageContent | undefined {
  if (!BashOutputSchema.safeParse(input.output).success) return undefined;
  // serializer 已经把完整 Bash provider-visible content 写入 artifact；
  // 这里必须只预览该 content，不能重进普通 formatter 后把 stderr/provider-error 文本完整追加回模型上下文。
  return formatBashPersistedOutputContent({
    content: input.content,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
  });
}

function formatProviderErrorContent(result: BashOutput): string {
  return [
    `Exit code ${result.exitCode}`,
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTextContentForModel(result: BashOutput): string {
  return [
    formatStdoutContentForModel(result),
    formatStderrForModel(result),
    formatBackgroundInfoForModel(result),
    result.staleReadFileStateHint?.trim() ?? "",
    result.ghRateLimitHint?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatStdoutContentForModel(result: BashOutput): string {
  let processedStdout = formatStdoutForModel(result.stdout);
  const persistedOutputPath =
    result.status === "backgrounded"
      ? undefined
      : (result.persistedOutputPath ?? result.rawOutputPath);
  if (persistedOutputPath) {
    processedStdout = formatBashPersistedOutputContent({
      content: processedStdout,
      originalBytes: observedOutputBytes(result),
      persistedPath: persistedOutputPath,
    });
  }
  return processedStdout;
}

function stringifyFallback(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function formatStdoutForModel(stdout: string): string {
  if (!stdout) return "";
  return stdout.replace(/^(\s*\n)+/, "").trimEnd();
}

function formatStderrForModel(result: BashOutput): string {
  let message = result.stderr.trim();
  if (result.interrupted) {
    if (message) message += "\n";
    message += "<error>Command was aborted before completion</error>";
  }
  return message;
}

export function isBashOutputProviderError(output: unknown): boolean {
  if (!isRecord(output)) return false;
  return isBashProviderErrorStatus(output);
}

function formatBackgroundInfoForModel(result: BashOutput): string {
  if (!result.backgroundTaskId) return "";
  const outputText = formatBackgroundOutputPaths(result);
  if (result.assistantAutoBackgrounded) {
    return `Command exceeded the assistant-mode blocking budget (${ASSISTANT_BLOCKING_BUDGET_MS / 1000}s) and was moved to the background with ID: ${result.backgroundTaskId}. It is still running \u2014 you will be notified when it completes.${outputText} In assistant mode, delegate long-running work to a subagent or use run_in_background to keep this conversation responsive.`;
  }
  if (result.backgroundedByUser) {
    return `Command was manually backgrounded by user with ID: ${result.backgroundTaskId}.${stripTrailingPeriod(outputText)}`;
  }
  const readHint = outputText
    ? ` To check interim output, use ${READ_TOOL_NAME} on that file path.`
    : "";
  return `Command running in background with ID: ${result.backgroundTaskId}.${outputText} You will be notified when it completes.${readHint}`;
}

function formatBackgroundOutputPaths(result: BashOutput): string {
  // Bash 的 stdout/stderr 已直接写入单一输出文件，继续追加 stdout/stderr legacy path
  // 会让模型看到与单一输出文件不一致的双路径信息。
  const outputPath =
    result.rawOutputPath ??
    result.persistedOutputPath ??
    result.stdoutPersistedOutputPath ??
    result.stderrPersistedOutputPath;
  return outputPath ? ` Output is being written to: ${outputPath}.` : "";
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function observedOutputBytes(result: BashOutput): number {
  if (typeof result.persistedOutputSize === "number") return result.persistedOutputSize;
  if (
    typeof result.stdoutPersistedOutputSize === "number" ||
    typeof result.stderrPersistedOutputSize === "number"
  ) {
    return (result.stdoutPersistedOutputSize ?? 0) + (result.stderrPersistedOutputSize ?? 0);
  }
  return (
    (result.stdoutBytes ?? Buffer.byteLength(result.stdout, "utf8")) +
    (result.stderrBytes ?? Buffer.byteLength(result.stderr, "utf8"))
  );
}

function formatBashPersistedOutputContent(input: {
  content: string;
  originalBytes: number;
  persistedPath: string;
}): string {
  return formatPersistedOutputEnvelope({
    content: input.content,
    formatBytes: formatBashOutputByteSize,
    originalBytes: input.originalBytes,
    persistedPath: input.persistedPath,
    previewChars: MODEL_RESULT_PREVIEW_CHARS,
  });
}

function formatBashOutputByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  const kb = bytes / 1024;
  if (kb < 1) return `${bytes} bytes`;
  if (kb < 1024) return `${trimUnit(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimUnit(mb)}MB`;
  return `${trimUnit(mb / 1024)}GB`;
}

function trimUnit(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function maybeImageContent(result: BashOutput): ModelMessageContent | undefined {
  if (!result.isImage) return undefined;
  const parsed = parseImageDataUrl(result.stdout, { allowWhitespace: true });
  if (!parsed) return undefined;
  return [
    {
      type: "image",
      mediaType: parsed.mediaType,
      dataUrl: parsed.dataUrl,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
