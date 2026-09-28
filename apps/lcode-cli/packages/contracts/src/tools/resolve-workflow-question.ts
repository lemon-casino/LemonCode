// ============================================================
// ResolveWorkflowQuestion Tool - 主代理回答 actor 升级上来的阻塞问题
// ============================================================
// 见端口 `DynamicWorkflowRunPort.resolveQuestion`
// （interfaces/dynamic-workflow-run.port.ts）。
//
// 只收 qid 而不收 `(run_id, question_id)` 对：qid 全局唯一（跨 run），多 run 并发时让模型
// 自己配对是错配的温床。失败走 ToolHandlerFailure（core 侧），所以本输出只有成功形。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESOLVE_WORKFLOW_QUESTION_TOOL_NAME = "ResolveWorkflowQuestion";

export const ResolveWorkflowQuestionInputSchema = z
  .object({
    // snake_case 照 GetWorkflowRun 的 run_id / ResumeWorkflowRun 的 run_id：在模型眼里这是
    // 同一族的不透明标识键。
    question_id: z
      .string()
      .min(1)
      .describe(
        "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
      ),
    answer: z
      .string()
      .min(1)
      .describe("The answer text, delivered verbatim to the subagent that asked"),
  })
  .strict();

export type ResolveWorkflowQuestionInput = z.infer<typeof ResolveWorkflowQuestionInputSchema>;

export const ResolveWorkflowQuestionInputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionInputSchema,
);

export const ResolveWorkflowQuestionOutputSchema = z
  .object({
    ok: z.literal(true),
    qid: z.string().min(1),
    /** 给模型的确认文案（散文不是契约字段，schema 只保证在场）。 */
    response: z.string(),
  })
  .strict();

export type ResolveWorkflowQuestionOutput = z.infer<typeof ResolveWorkflowQuestionOutputSchema>;

export const ResolveWorkflowQuestionOutputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionOutputSchema,
);
