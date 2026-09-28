import { z } from "zod";

export const ToolCommandStatusSchema = z.enum([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "backgrounded",
]);

export type ToolCommandStatus = z.infer<typeof ToolCommandStatusSchema>;

export const CommandExecutionTelemetrySchema = z
  .object({
    runMs: z.number().int().nonnegative().optional(),
    firstOutputMs: z.number().int().nonnegative().optional(),
    noOutputMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    category: z.string().max(64).optional(),
    /**
     * 只允许公开 Registry 中的可执行文件名或固定低基数桶；禁止放入原始命令或参数。
     */
    name: z.string().max(128).optional(),
    count: z.number().int().nonnegative().optional(),
    status: ToolCommandStatusSchema,
    /**
     * 本地诊断字段；远端 Trace Exporter 必须显式忽略，避免成为高基数远端维度。
     */
    hash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
  })
  .strict();

export type CommandExecutionTelemetry = z.infer<typeof CommandExecutionTelemetrySchema>;

export const FileSystemExecutionTelemetrySchema = z
  .object({
    readMs: z.number().int().nonnegative().optional(),
    writeMs: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    maxFileBytes: z.number().int().nonnegative().optional(),
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

export type FileSystemExecutionTelemetry = z.infer<
  typeof FileSystemExecutionTelemetrySchema
>;

export const PatchExecutionTelemetrySchema = z
  .object({
    matchMs: z.number().int().nonnegative().optional(),
    hunkCount: z.number().int().nonnegative().optional(),
    matchAttempts: z.number().int().nonnegative().optional(),
  })
  .strict();

export type PatchExecutionTelemetry = z.infer<typeof PatchExecutionTelemetrySchema>;

export const ToolExecutionTelemetryDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: CommandExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("filesystem"),
      filesystem: FileSystemExecutionTelemetrySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("patch"),
      filesystem: FileSystemExecutionTelemetrySchema,
      patch: PatchExecutionTelemetrySchema,
    })
    .strict(),
]);

export type ToolExecutionTelemetryDetail = z.infer<
  typeof ToolExecutionTelemetryDetailSchema
>;

/**
 * 工具执行结果摘要，随 ToolCallResult 事件落本地存储；命令专属字段只能进入判别 detail，
 * 避免非命令工具伪造 exitCode 等不适用事实。
 */
export const ToolExecutionTelemetrySchema = z
  .object({
    totalMs: z.number().int().nonnegative().optional(),
    permissionWaitMs: z.number().int().nonnegative().optional(),
    detail: ToolExecutionTelemetryDetailSchema.optional(),
  })
  .strict();

export type ToolExecutionTelemetry = z.infer<typeof ToolExecutionTelemetrySchema>;
