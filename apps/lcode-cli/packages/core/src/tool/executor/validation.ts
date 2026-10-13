import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  ModelToolInputErrorSchema,
} from "@lcode/contracts";
import type { RuntimeInputValidationIssue } from "../input-normalization.js";
import { createInitialInputValidationModelContent } from "../input-validation-model-content.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolEntry } from "../types.js";

const INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY = "initialInputValidationModelContent";

export function validateOutput(output: unknown, entry: ToolEntry): void {
  const runtimeSchemaValidation = validateRuntimeSchema(output, entry.runtimeOutputSchema);
  if (runtimeSchemaValidation === true) return;
  if (Array.isArray(runtimeSchemaValidation)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Tool output failed runtimeOutputSchema validation",
      {
        context: {
          errors: runtimeSchemaValidation.slice(0, 20),
          toolName: entry.metadata.name,
        },
        recoverable: false,
      },
    );
  }

  const validation = validateJsonSchemaValue(output, entry.outputSchema);
  if (validation.valid) return;

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool output failed outputSchema validation",
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: false,
    },
  );
}

function validateRuntimeSchema(value: unknown, schema: unknown): true | string[] | undefined {
  if (!isSafeParseSchema(schema)) return undefined;
  const parsed = schema.safeParse(value);
  if (parsed.success) return true;
  return parsed.error.issues.map((issue) => issue.message);
}

function isSafeParseSchema(schema: unknown): schema is {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

export function validateInput(input: unknown, entry: ToolEntry): Error | undefined {
  // 模型面 schema 不包含审批窗的 actor_model_overrides 等运行时事实；拿它复核审批修改会
  // 拒绝已批准的模型配置。初始模型输入仍独立校验模型面，执行态改用工具声明的运行时 schema。
  const runtimeSchemaValidation = validateRuntimeSchema(input, entry.runtimeInputSchema);
  if (runtimeSchemaValidation === true) return undefined;
  if (Array.isArray(runtimeSchemaValidation)) {
    return createInputValidationError(entry, runtimeSchemaValidation);
  }
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  return createInputValidationError(entry, validation.errors);
}

export function validateInitialModelToolInput(
  input: unknown,
  entry: ToolEntry,
  runtimeValidationIssues?: readonly RuntimeInputValidationIssue[],
  inputError?: unknown,
): Error | undefined {
  if (inputError !== undefined) {
    // 根因：adapter 的空对象占位会触发误导的缺参提示，甚至通过宽松 schema。
    // 严格校验安全诊断后直接拒绝，模型沿原 tool result 通道重交，不调用 handler。
    const parsed = ModelToolInputErrorSchema.safeParse(inputError);
    const reason = !parsed.success
      ? "Model tool input error metadata is invalid."
      : parsed.data.code === "null_input"
        ? "Tool arguments must be a JSON object, but received null."
        : "Tool arguments contain invalid or incomplete JSON.";
    const message = `InputValidationError: ${entry.metadata.name} failed: ${reason} No tool action was performed. Retry this tool call with a complete JSON object; split large content into smaller calls if necessary.`;
    return createInputValidationError(
      entry,
      [reason],
      `<tool_use_error>${message}</tool_use_error>`,
    );
  }
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  // 模型原始参数的首次 schema 失败需要把具体问题回传给模型；Hook 或权限
  // 修改后的输入属于不同生命周期，不能复用这段 provider-visible 内容。
  const modelContent = createInitialInputValidationModelContent(
    entry,
    validation.issues,
    runtimeValidationIssues,
  );
  return createInputValidationError(entry, validation.errors, modelContent);
}

export function getInitialInputValidationModelContent(error: Error): string | undefined {
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const modelContent = error.context?.[INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY];
  return typeof modelContent === "string" ? modelContent : undefined;
}

function createInputValidationError(
  entry: ToolEntry,
  errors: string[],
  modelContent?: string,
): Error {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool input failed inputSchema validation",
    {
      context: {
        errors: errors.slice(0, 20),
        toolName: entry.metadata.name,
        ...(modelContent === undefined
          ? {}
          : { [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: modelContent }),
      },
      recoverable: true,
    },
  );
}
