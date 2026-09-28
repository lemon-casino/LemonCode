import { BashOutputSchema, type ToolResultDisplayPayload } from "@lcode/contracts";

export function createBashResultDisplay(output: unknown): ToolResultDisplayPayload | undefined {
  const parsed = BashOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  const result = parsed.data;
  if (result.status === "backgrounded" || result.isImage || result.structuredContent?.length)
    return undefined;
  const outputPath = result.persistedOutputPath ?? result.rawOutputPath;
  const truncated = result.stdoutTruncated === true || result.stderrTruncated === true;
  if (!truncated && !outputPath) return undefined;

  // 原因：模型 envelope 会再次缩短正文且隐藏 Bash 的截断事实；Desktop 必须使用
  // 独立的有界头部展示，不能解析模型文案或把文件路径误当协议按需读取 ref。
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const exceedsDisplayBudget = Buffer.byteLength(text, "utf8") > 150_000;
  const bounded = exceedsDisplayBudget
    ? new TextDecoder().decode(Buffer.from(text).subarray(0, 150_000), { stream: true })
    : text;
  return {
    kind: "bash_output",
    output: bounded,
    truncated: truncated || exceedsDisplayBudget,
    ...(outputPath ? { outputPath } : {}),
  };
}
