// ============================================================
// submit_result Tool - actor terminal structured-result submission
// ============================================================
// 工作流 actor（子 AgentRuntime）用它提交本次 ask 的结构化结果。声明的输入是通用的
// 任意 JSON（单个 `result` 属性）——每个 ask 的具体 schema 不进工具声明，而是随 ask
// 指令消息的 epilogue 下发，以维持 frozen-per-actor 的工具缓存不变式。

import { z } from "zod";
import { TOOL_JSON_SCHEMA_VERSION, toToolJsonSchema } from "./json-schema.js";

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const SubmitResultInputSchema = z
  .object({
    // 有意保持通用：不约束 result 的形状。具体 per-ask schema 在 ask 指令 epilogue 里，
    // 由引擎在 WorkflowSubmitPort 侧校验；这样工具声明可跨 ask 冻结、命中 prompt 缓存。
    result: z
      .unknown()
      .describe(
        "The structured result for this ask, matching the JSON schema given in the ask instructions.",
      ),
  })
  .strict();

export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

export const SubmitResultInputJsonSchema = toToolJsonSchema(SubmitResultInputSchema);

/**
 * mono 子代理的 typed 工具声明：`result` 的子 schema 就是该 actor 唯一的 ask 结果 schema。运行时 zod 校验仍是上面的
 * 通用 `SubmitResultInputSchema`——per-ask 形状由引擎在 WorkflowSubmitPort 侧校验，工具声明只是让
 * provider 看到（并在支持时原生约束）它。外层对象与通用声明同形：单个必填 `result`、禁止多余键。
 */
export function typedSubmitResultInputSchema(
  resultSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      result: {
        description: "The structured result for this ask.",
        ...resultSchema,
      },
    },
    required: ["result"],
    additionalProperties: false,
    $schema: TOOL_JSON_SCHEMA_VERSION,
  };
}

export const SubmitResultOutputSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

export type SubmitResultOutput = z.infer<typeof SubmitResultOutputSchema>;

export const SubmitResultOutputJsonSchema = toToolJsonSchema(SubmitResultOutputSchema);
