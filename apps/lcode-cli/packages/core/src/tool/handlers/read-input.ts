import {
  CoreErrorType,
  ReadInputSchema,
  createCoreError,
  getReadPdfPagesValidationFailure,
  type ReadInput,
} from "@lcode/contracts";
import type { ToolInputValidationResult } from "../types.js";

export function parseReadInput(input: unknown): ReadInput {
  const parsed = ReadInputSchema.safeParse(input);
  if (parsed.success) return parsed.data as ReadInput;

  const toolUseErrorMessage = getReadInputToolUseErrorMessage(parsed.error);
  if (!toolUseErrorMessage) {
    throw parsed.error;
  }

  // Read 输入预检失败应以 <tool_use_error> 文本进入 provider；
  // 直接透出 ZodError JSON 会让 binary/device preflight 与 capture 偏离。
  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    `<tool_use_error>${toolUseErrorMessage}</tool_use_error>`,
    {
      cause: parsed.error,
      context: {
        code: "read_input_preflight_failed",
      },
      recoverable: true,
    },
  );
}

export function validateReadInput(input: unknown): ToolInputValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { result: true };
  }

  const candidate = input as { file_path?: unknown; pages?: unknown };
  if (typeof candidate.file_path !== "string" || typeof candidate.pages !== "string") {
    return { result: true };
  }

  // PDF pages 的语义约束只存在于 runtime schema 时，JSON Schema 会接受任意
  // string，导致错误调用穿过 Hook 和权限后才在 handler 抛出裸 ZodError。
  const failure = getReadPdfPagesValidationFailure(candidate.file_path, candidate.pages);
  return failure ? { result: false, ...failure } : { result: true };
}

function getReadInputToolUseErrorMessage(error: unknown): string | undefined {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;

  for (const issue of issues) {
    if (!isReadInputToolUseIssue(issue)) continue;
    return issue.message;
  }
  return undefined;
}

function isReadInputToolUseIssue(issue: unknown): issue is { message: string } {
  if (!issue || typeof issue !== "object") return false;
  const record = issue as { code?: unknown; message?: unknown; path?: unknown };
  if (record.code !== "custom" || typeof record.message !== "string") return false;
  if (!Array.isArray(record.path)) return false;
  return record.path.length === 1 && record.path[0] === "file_path";
}
