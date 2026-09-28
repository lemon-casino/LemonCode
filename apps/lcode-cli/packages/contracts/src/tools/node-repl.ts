import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const JsInputBaseShape = {
  // 同一模型 schema 同时服务 persistent core REPL 与 fresh-kernel Browser Use MCP；
  // 字段文案不能替任一执行边界承诺跨调用状态，生命周期由各自 tool description 说明。
  code: z.string().describe("JavaScript code to execute in the Node REPL session"),
  // 只写 optional 无法让模型判断何时覆盖默认值，长等待容易在副作用完成后超时。
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      "Per-call timeout in milliseconds. You MUST provide this when the code is expected to run longer than 30000 ms, including all awaited operations. Set it to at least the estimated total runtime plus 15000 ms. If that exceeds the 120000 ms maximum, split the work into multiple calls.",
    ),
};
const JsUserTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Required short user-facing title in the user's language that describes the intended action without implementation terms such as js, JavaScript, or node_repl",
  );

/** js：在持久 REPL 里执行一段 JS 代码。 */
export const JsInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema,
  })
  .strict();
export type JsInput = z.infer<typeof JsInputSchema>;

// 新调用必须提供用户可读标题，但旧会话和第三方 provider 的历史调用可能没有该字段。
export const JsRuntimeInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema.optional(),
  })
  .strict();
export type JsRuntimeInput = z.infer<typeof JsRuntimeInputSchema>;

export const JsOutputSchema = z
  .object({
    result: z.string().optional(),
    logs: z.string(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    // nodeRepl.emitImage 收集的图片（如 tab.screenshot 的截图）；formatModelContent 会转成 image 内容块给模型。
    images: z.array(z.object({ base64: z.string(), mimeType: z.string() }).strict()).optional(),
    // 模型显式 tab.screenshot() 原始 PNG 的 session artifact 绝对路径。
    browserScreenshotPaths: z.array(z.string()).optional(),
    responseMeta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type JsOutput = z.infer<typeof JsOutputSchema>;

export const JsInputJsonSchema = toToolJsonSchema(JsInputSchema);
export const JsOutputJsonSchema = toToolJsonSchema(JsOutputSchema);
