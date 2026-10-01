import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.
- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.
- For local_agent tasks: do not use TaskOutput to wait or poll. The Agent launch result is provisional; the final result arrives in an automatic completion notification. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.
- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).

- Takes an exact task_id from a tool result or the /tasks command; do not reconstruct or guess IDs.
- Returns output and status for supported tasks. block=true waits for non-agent tasks; a running background local_agent always returns not_ready immediately.
- Use block=false for a non-blocking status check. A local_agent terminal snapshot does not replace its completion notification.`;

export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600_000).default(30_000).describe("Max wait time in ms"),
  })
  .strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
  })
  .strict();

export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}
