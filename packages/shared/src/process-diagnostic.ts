import { z } from "zod";

// 启动早期或协议故障时 stdout 尚不可用，进程诊断使用独立的 stderr 单行契约。
export const LCODE_PROCESS_DIAGNOSTIC_PREFIX = "[lcode-process-exception] ";
export const LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS = 128;
export const LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4_000;
export const LCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS = 16_000;
export const LCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS = 128 * 1024;
export const LCODE_AGENT_LIFECYCLE_LOG_MARKER = "[lcode-agent-lifecycle-reported]";

const processErrorKindSchema = z.enum(["uncaughtException", "unhandledRejection"]);
const diagnosticV1Schema = z
  .object({
    version: z.literal(1),
    errorId: z.uuid(),
    kind: processErrorKindSchema,
    origin: processErrorKindSchema,
    name: z.string().min(1).max(LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    stack: z.string().max(LCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export const LCODE_PROCESS_DIAGNOSTIC_CAUSES_MAX = 4;
export const LCODE_PROCESS_DIAGNOSTIC_FRAMES_MAX = 16;
export const LCODE_PROCESS_DIAGNOSTIC_FRAME_MAX_CHARS = 512;
const errorDetailSchema = z
  .object({
    name: z.string().min(1).max(LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    code: z.string().max(LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS).optional(),
    frames: z
      .array(z.string().max(LCODE_PROCESS_DIAGNOSTIC_FRAME_MAX_CHARS))
      .max(LCODE_PROCESS_DIAGNOSTIC_FRAMES_MAX),
  })
  .strict();
export const processNetworkDiagnosticSchema = z
  .object({
    ownerId: z.uuid(),
    phase: z.enum(["active", "closing", "closed", "failed"]),
    activeRequests: z.number().int().nonnegative(),
    started: z.number().int().nonnegative(),
    finished: z.number().int().nonnegative(),
    connections: z
      .array(
        z
          .object({
            connectionId: z.uuid(),
            protocol: z.enum(["h1", "h2"]),
            phase: z.enum(["connected", "retired"]),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type ProcessNetworkDiagnostic = z.infer<typeof processNetworkDiagnosticSchema>;
const diagnosticV2Schema = diagnosticV1Schema.extend({
  version: z.literal(2),
  code: errorDetailSchema.shape.code,
  frames: errorDetailSchema.shape.frames,
  causes: z.array(errorDetailSchema).max(LCODE_PROCESS_DIAGNOSTIC_CAUSES_MAX),
  truncated: z
    .object({
      messageChars: z.number().int().nonnegative(),
      stackChars: z.number().int().nonnegative(),
      frames: z.boolean(),
      causes: z.boolean(),
    })
    .strict(),
  runtime: z
    .object({
      node: z.string().max(128),
      electron: z.string().max(128).optional(),
      undici: z.string().max(128),
      cli: z.string().max(128),
    })
    .strict(),
  network: z.array(processNetworkDiagnosticSchema).max(8).optional(),
});
export const lcodeProcessDiagnosticSchema = z.discriminatedUnion("version", [
  diagnosticV1Schema,
  diagnosticV2Schema,
]);
export type LCodeProcessDiagnostic = z.infer<typeof lcodeProcessDiagnosticSchema>;

/** Host 在脱敏后再次执行 schema 限长，v2 的嵌套原因也不能透传原文本。 */
export function redactLCodeProcessDiagnostic(
  diagnostic: LCodeProcessDiagnostic,
  redact: (text: string) => string,
): LCodeProcessDiagnostic {
  const detail = (value: z.infer<typeof errorDetailSchema>) => ({
    name: redact(value.name).slice(0, LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: redact(value.message).slice(0, LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    ...(value.code === undefined
      ? {}
      : { code: redact(value.code).slice(0, LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS) }),
    frames: value.frames.map((frame) =>
      redact(frame).slice(0, LCODE_PROCESS_DIAGNOSTIC_FRAME_MAX_CHARS),
    ),
  });
  return {
    ...diagnostic,
    name: redact(diagnostic.name).slice(0, LCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: redact(diagnostic.message).slice(0, LCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    ...(diagnostic.stack === undefined
      ? {}
      : { stack: redact(diagnostic.stack).slice(0, LCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS) }),
    ...(diagnostic.version === 2
      ? { ...detail(diagnostic), causes: diagnostic.causes.map(detail) }
      : {}),
  };
}

export function parseLCodeProcessDiagnostic(line: string): LCodeProcessDiagnostic | undefined {
  if (
    !line.startsWith(LCODE_PROCESS_DIAGNOSTIC_PREFIX) ||
    line.length > LCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS
  ) {
    return undefined;
  }
  try {
    const result = lcodeProcessDiagnosticSchema.safeParse(
      JSON.parse(line.slice(LCODE_PROCESS_DIAGNOSTIC_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    // 诊断旁路不得因损坏帧中断业务协议或退出处理。
    return undefined;
  }
}
