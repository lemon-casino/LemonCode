// ============================================================
// ResumeWorkflowRun Tool - 恢复一个 cancelled / Interrupted 的 workflow run
// ============================================================
// 见端口
// `DynamicWorkflowRunPort.resume` 的契约（interfaces/dynamic-workflow-run.port.ts）。
//
// 这是 workflow run 恢复的第三个入口（继 UI 详情页按钮、CLI /dwf resume 之后），执行底座零
// 改动：同一条 `port.resume(runId)`、同 runId 原地续跑（脚本由 scriptHash 钉死、实参与
// caps 沿用 journal 记录、已完结节点纯 replay、未完结节点重新派发）。
//
// 输出只有成功形：失败走 ToolHandlerFailure（core 侧），不进本 schema——所以全字段必填、
// 无 optional。`status: "backgrounded"` 让 executor 的自动追踪按输出形状认领它，走
// CreateWorkflow 同一条 trackBackgroundTask。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESUME_WORKFLOW_RUN_TOOL_NAME = "ResumeWorkflowRun";

export const ResumeWorkflowRunInputSchema = z
  .object({
    // snake_case 照 GetWorkflowRun 的 run_id（它又照 TaskOutput 的 task_id）：在模型眼里这
    // 三个键是同一族的 run/task 标识。可恢复集（cancelled ∪ failed+Interrupted）写在
    // describe 里，判定权威在 port.resume 服务端——这里只是路由引导。
    run_id: z
      .string()
      .min(1)
      .describe(
        "The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns",
      ),
  })
  .strict();

export type ResumeWorkflowRunInput = z.infer<typeof ResumeWorkflowRunInputSchema>;

export const ResumeWorkflowRunInputJsonSchema = toToolJsonSchema(ResumeWorkflowRunInputSchema);

/**
 * 成功输出：run 已恢复并在后台飞行。
 *
 * - `backgroundTaskId ≡ runId`（与 CreateWorkflow 的 backgrounded 输出同一恒等式），取消、
 *   TaskOutput 查询、终态通知三条路径共用这一个键。
 * - `status` 只收 `"backgrounded"` 字面量：executor 的后台追踪按这个形状触发，多一个值
 *   就多一条要解释的生命周期分支。
 * - `response` 是给模型的引导文案（勿轮询、等通知），由 core handler 构造——它是散文不是
 *   契约字段，schema 只保证在场。
 */
export const ResumeWorkflowRunOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    response: z.string(),
    status: z.literal("backgrounded"),
    backgroundTaskId: z.string().min(1),
  })
  .strict();

export type ResumeWorkflowRunOutput = z.infer<typeof ResumeWorkflowRunOutputSchema>;

export const ResumeWorkflowRunOutputJsonSchema = toToolJsonSchema(ResumeWorkflowRunOutputSchema);
