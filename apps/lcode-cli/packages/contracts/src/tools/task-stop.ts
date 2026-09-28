import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_STOP_TOOL_NAME = "TaskStop";

export const TaskStopInputSchema = z
  .object({
    task_id: z.string().optional().describe("The ID of the background task to stop"),
    shell_id: z
      .string()
      .optional()
      .describe("Deprecated: use task_id instead"),
  })
  .strict();

export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export const TaskStopInputJsonSchema = toToolJsonSchema(TaskStopInputSchema);

export const TaskStopOutputSchema = z
  .object({
    message: z.string(),
    task_id: z.string(),
    task_type: z.string(),
    command: z.string().optional(),
  })
  .strict();

export type TaskStopOutput = z.infer<typeof TaskStopOutputSchema>;

export const TaskStopOutputJsonSchema = toToolJsonSchema(TaskStopOutputSchema);
