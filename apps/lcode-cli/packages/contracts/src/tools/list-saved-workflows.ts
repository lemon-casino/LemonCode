// ============================================================
// ListSavedWorkflows Tool - 枚举本项目保存的 dwf 定义
// ============================================================
//
// 与 ListWorkflowRuns 是**两件事**：那个列的是跑过的 run（历史），这个列的是可以拿来跑的
// 定义（清单）。名字刻意在 "Runs" / "SavedWorkflows" 上分开，因为模型最容易犯的错就是把
// 「有哪些工作流可用」问成「有哪些工作流跑过」。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SavedWorkflowEntrySchema, SavedWorkflowInvalidEntrySchema } from "./saved-workflow.js";

export const LIST_SAVED_WORKFLOWS_TOOL_NAME = "ListSavedWorkflows";

export const ListSavedWorkflowsInputSchema = z
  .object({})
  // 与 ListWorkflowRuns 同一条约束：刻意没有 cwd 输入，工具恒扫当前会话的工作目录。
  // 模型无权跨项目扫盘，这同时是 `sideEffectScope: "none"` 成立的前提。
  .strict();

export type ListSavedWorkflowsInput = z.infer<typeof ListSavedWorkflowsInputSchema>;

export const ListSavedWorkflowsInputJsonSchema = toToolJsonSchema(ListSavedWorkflowsInputSchema);

export const ListSavedWorkflowsOutputSchema = z
  .object({
    workflows: z.array(SavedWorkflowEntrySchema),
    /** 读不出来的文件。为空时缺席——一个空数组会让每次调用都挂一个噪音字段。 */
    invalid: z.array(SavedWorkflowInvalidEntrySchema).optional(),
  })
  .strict();

export type ListSavedWorkflowsOutput = z.infer<typeof ListSavedWorkflowsOutputSchema>;

export const ListSavedWorkflowsOutputJsonSchema = toToolJsonSchema(ListSavedWorkflowsOutputSchema);
