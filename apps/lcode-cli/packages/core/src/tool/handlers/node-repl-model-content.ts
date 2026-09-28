import type { JsOutput, ModelMessageContent, ModelMessageContentBlock } from "@lcode/contracts";

export function formatJsModelContent(output: unknown): ModelMessageContent {
  const o = output as JsOutput;
  const parts: string[] = [];
  if (o.error) {
    const errorHeader = `${o.error.name}: ${o.error.message}`;
    parts.push(errorHeader);
    // Error.stack 首行已经重复 name/message；再拼完整 stack 会让模型看到两遍
    // 同一错误正文。message 可能包含多行 locator context，必须剥离完整 header，不能只删第一行。
    const stackFrames = o.error.stack
      ? o.error.stack.startsWith(`${errorHeader}\n`)
        ? o.error.stack.slice(errorHeader.length + 1).trimEnd()
        : o.error.stack.split("\n").slice(1).join("\n").trimEnd()
      : undefined;
    if (stackFrames?.trim()) parts.push(stackFrames);
  }
  if (o.logs) parts.push(o.logs);
  if (o.result !== undefined) parts.push(`=> ${o.result}`);
  if (o.browserScreenshotPaths && o.browserScreenshotPaths.length > 0) {
    parts.push(
      o.browserScreenshotPaths.map((path) => `Browser screenshot saved to: ${path}`).join("\n"),
    );
  }
  const text = parts.length > 0 ? parts.join("\n") : "(no output)";
  // nodeRepl.emitImage 收集的图片 → image 内容块（dataUrl），让模型直接"看"到截图。
  // Canonical result order puts emitted rasters before their textual summary.
  if (o.images && o.images.length > 0) {
    const blocks: ModelMessageContentBlock[] = [];
    for (const img of o.images) {
      blocks.push({
        type: "image",
        mediaType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.base64}`,
      });
    }
    blocks.push({ type: "text", text });
    return blocks;
  }
  return text;
}
