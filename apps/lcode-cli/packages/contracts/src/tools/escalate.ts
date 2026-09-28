// ============================================================
// escalate Tool - actor 把阻塞问题升级给主代理
// ============================================================
// 与 `submit_result` 完全同构地注入 actor 会话
// （端口在场即注册、`tools:"none"` 下仍由 core 补回），但两者结算的是不同的东西：
// submit 结算**这次 ask 的结果**，escalate 结算**一次问答**。
//
// 输出形状刻意是「带判别位的扁平对象」而不是 union：两支都是普通工具结果（不是错误），
// 模型读到的只有一段文本，判别位 `status` 只服务日志与结果投影。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ESCALATE_TOOL_NAME = "escalate";

export const EscalateInputSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "The single focused question that unblocks you. One question per call, answerable in a sentence.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "What you already tried and where exactly you are stuck — the evidence the answerer needs.",
      ),
  })
  .strict();

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export const EscalateInputJsonSchema = toToolJsonSchema(EscalateInputSchema);

/**
 * 一次升级的结局。
 *
 * - `answered`：`message` 是主代理给出的答案原文，`qid` 是这次问答的全局唯一 id。
 * - `refused`：`message` 是陈述现状与下一步的文案（预算已尽 / 无在飞 ask），`reason` 是
 *   判别键。**这不是错误**——把「预算已尽」渲染成 error tool_result 会让模型当成可重试的
 *   故障，反复撞同一堵墙，而那正是本特性要消灭的行为。
 */
export const EscalateOutputSchema = z
  .object({
    status: z.enum(["answered", "refused"]),
    message: z.string(),
    /** `answered` 才在场。 */
    qid: z.string().optional(),
    /** `refused` 才在场。 */
    reason: z.enum(["budget_exhausted", "no_active_ask"]).optional(),
  })
  .strict();

export type EscalateOutput = z.infer<typeof EscalateOutputSchema>;

export const EscalateOutputJsonSchema = toToolJsonSchema(EscalateOutputSchema);
