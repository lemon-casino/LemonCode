import type { Logger, ModelToolCall, ModelToolInputError } from "@lcode/contracts";

interface NormalizeModelToolInputOptions {
  logger?: Logger;
  source: "generateText" | "streamText";
  toolName?: string;
}

export function normalizeModelToolInput(
  input: unknown,
  options: NormalizeModelToolInputOptions,
): Pick<ModelToolCall, "input" | "inputError"> {
  if (input === undefined) {
    return { input: {} };
  }
  if (input === null) {
    // 上游会先把合法 JSON 字面量 "null" 解析成原生 null；
    // 这里必须与 string parse-null 使用相同恢复语义，且不能伪造原始长度。
    return rejectMalformedToolInput(
      new TypeError("Model tool input must not be null"),
      options,
      { code: "null_input" },
      { inputType: "null" },
    );
  }
  if (typeof input !== "string") {
    return { input };
  }
  if (input.length === 0) {
    return { input: {} };
  }

  try {
    const normalizedInput = JSON.parse(stripByteOrderMark(input));
    if (normalizedInput === null) {
      return rejectMalformedToolInput(
        new TypeError("Model tool input must not be null"),
        options,
        { code: "null_input", inputLength: input.length },
        { inputLength: input.length },
      );
    }
    return { input: normalizedInput };
  } catch (error) {
    // 根因：非法或截断的 JSON 被擦成 {}，既误报必填字段缺失，又可能执行无参数工具。
    // 保留安全解析结果，由原 executor 闭合一次失败；不能把整个请求重放而重复 sibling 副作用。
    return rejectMalformedToolInput(
      error,
      options,
      { code: "invalid_json", inputLength: input.length },
      { inputLength: input.length },
    );
  }
}

function rejectMalformedToolInput(
  error: unknown,
  options: NormalizeModelToolInputOptions,
  inputError: ModelToolInputError,
  inputContext: { inputLength: number } | { inputType: "null" },
): Pick<ModelToolCall, "input" | "inputError"> {
  options.logger?.warn("Model tool input JSON normalization failed", {
    event: "model.tool_input.normalize_failed",
    ...inputContext,
    module: "adapters.model.tool-input-normalization",
    parseErrorType: parseErrorType(error),
    recovery: "tool_error",
    source: options.source,
    status: "failed",
    toolName: options.toolName,
  });
  return { input: {}, inputError };
}

function stripByteOrderMark(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function parseErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
