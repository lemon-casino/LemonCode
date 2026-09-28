// ============================================================
// Todo Tools - session task checklist
// ============================================================
// References: session todo and planning tool behavior

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const TodoStatus = {
  Pending: "pending",
  InProgress: "in_progress",
  Completed: "completed",
} as const;

export type TodoStatus = (typeof TodoStatus)[keyof typeof TodoStatus];

export const TodoPriority = {
  High: "high",
  Medium: "medium",
  Low: "low",
} as const;

export type TodoPriority = (typeof TodoPriority)[keyof typeof TodoPriority];

export const TodoItemSchema = z.object({
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Current status of the task"),
  priority: z.enum(["high", "medium", "low"]).describe("Priority level of the task"),
});

export type TodoItem = z.infer<typeof TodoItemSchema>;

export const TodoReadInputSchema = z.object({}).strict();
export type TodoReadInput = z.infer<typeof TodoReadInputSchema>;

export const TodoReadInputJsonSchema = toToolJsonSchema(TodoReadInputSchema);

export interface TodoReadOutput {
  todos: TodoItem[];
}

export const TodoReadOutputSchema = z
  .object({
    todos: z.array(TodoItemSchema),
  })
  .strict();

export type ParsedTodoReadOutput = z.infer<typeof TodoReadOutputSchema>;

export const TodoReadOutputJsonSchema = toToolJsonSchema(TodoReadOutputSchema);

export const TodoWriteInputSchema = z
  .object({
    todos: z
      .array(TodoItemSchema)
      .describe("The complete updated todo list. At most one item may be in_progress at a time."),
  })
  .strict();
// 多 subagent / 并行任务下需要允许多个 in_progress，旧的 schema 硬拒绝会让
// TodoWrite 失败并触发后续调度组被跳过；先整段注释保留，便于回滚或对比。
// .superRefine((input, context) => {
//   const inProgressCount = input.todos.filter((todo) => todo.status === "in_progress").length;
//   if (inProgressCount <= 1) return;
//   context.addIssue({
//     code: z.ZodIssueCode.custom,
//     message: "At most one todo can be in_progress",
//     path: ["todos"],
//   });
// });

export type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export const TodoWriteInputJsonSchema = toToolJsonSchema(TodoWriteInputSchema);

export interface TodoSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export interface TodoWriteOutput {
  oldTodos: TodoItem[];
  todos: TodoItem[];
  summary: TodoSummary;
}

export const TodoSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  })
  .strict();

export const TodoWriteOutputSchema = z
  .object({
    oldTodos: z.array(TodoItemSchema),
    todos: z.array(TodoItemSchema),
    summary: TodoSummarySchema,
  })
  .strict();

export type ParsedTodoWriteOutput = z.infer<typeof TodoWriteOutputSchema>;

export const TodoWriteOutputJsonSchema = toToolJsonSchema(TodoWriteOutputSchema);

export interface TodoReadToolCall {
  id: ToolCallId;
  name: "TodoRead";
  input: TodoReadInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface TodoWriteToolCall {
  id: ToolCallId;
  name: "TodoWrite";
  input: TodoWriteInput;
  traceId: TraceId;
  startedAt: Date;
}

export function isTodoToolName(value: string | undefined): value is "TodoRead" | "TodoWrite" {
  return value === "TodoRead" || value === "TodoWrite";
}

export function todoItemsFromToolResultContent(content: string): TodoItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const readResult = TodoReadOutputSchema.safeParse(parsed);
  if (readResult.success) {
    return cloneTodos(readResult.data.todos);
  }

  const writeResult = TodoWriteOutputSchema.safeParse(parsed);
  if (writeResult.success) {
    return cloneTodos(writeResult.data.todos);
  }

  return undefined;
}

export function formatTodoStateForModel(todos: readonly TodoItem[]): string {
  if (todos.length === 0) {
    return "";
  }

  return [
    "Current session todo state (authoritative):",
    ...todos.map(
      (todo, index) => `${index + 1}. [${todo.status}][${todo.priority}] ${todo.content}`,
    ),
  ].join("\n");
}

function cloneTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}
