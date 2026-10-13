// ============================================================
// EvalWorkflowSnippet Tool - 同步编译并运行一段动态工作流片段（scratch facade）
// ============================================================
// 工作流创作的实验通道：
// 同一条编译 / lowering / 沙箱 / world-read 执行面，内存 journal，完全瞬态。

import { z } from "zod";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const EVAL_WORKFLOW_SNIPPET_TOOL_NAME = "EvalWorkflowSnippet";

/** snippet 墙钟缺省 60s；上限 600s（测真实构建类检查需要余量）。 */
export const EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS = 60_000;
export const EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS = 600_000;
export const EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS = 1_000;

/** 「恰好给一段片段」的违规说明（与另外三个工具同一种语气）。 */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR =
  "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both, or neither, is ambiguous.";

// 来源错误必须指导模型修改实际字段；共享 schema 还要接受文件解析后的 code + path 执行态。
export const EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR =
  "The snippet was not executed. Both `code` and `path` were provided; choose exactly one source. " +
  "For inline code, REMOVE `path` entirely; for a file source, REMOVE `code`. " +
  "Preserve the original snippet and valid timeout. Do not use null, an empty string, a directory or a placeholder path.";

export const EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR =
  "The snippet was not executed. Neither `code` nor `path` was provided. " +
  "Provide `code` for the inline snippet OR `path` for an existing snippet file, never both. " +
  "Omit the unused field entirely; do not use null, an empty string or a placeholder path.";

export const EvalWorkflowSnippetInputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .optional()
      .describe(
        "TypeScript snippet written against the snippet facade (files.*, git.*, log, " +
          "plain interface declarations, top-level await and return). No agent()/report(). " +
          "Provide this OR `path`, never both. For inline code omit the `path` field entirely; do not fill it with null or a placeholder.",
      ),
    /**
     * 片段的第二条来源。**整个文件就是代码**：
     * 片段没有保存定义那套语义，一段恰好以 `/* lcode-workflow` 开头的文件也不该被当成声明块剥掉。
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "An existing file holding the snippet, relative to the working directory or absolute. Provide this OR `code`, never both; omit the unused field entirely. The whole file is the snippet, with no metadata block handling.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS)
      .max(EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS)
      .optional()
      .describe("Wall-clock timeout for the whole snippet in milliseconds. Default 60000."),
  })
  .strict();

export type EvalWorkflowSnippetInput = z.infer<typeof EvalWorkflowSnippetInputSchema>;

export const EvalWorkflowSnippetInputJsonSchema: ReturnType<typeof toToolJsonSchema> = {
  ...toToolJsonSchema(EvalWorkflowSnippetInputSchema),
  // 显式表达三个字段都可选，便于核对签名生成层；不把 XOR 加到允许 code + path 的执行态。
  required: [],
};

// logs 的界（协议边界上的所有载荷有界）：条数 × 单条长度，超出在 service 侧截断并标注。
export const EVAL_WORKFLOW_SNIPPET_MAX_LOGS = 100;
export const EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS = 2_048;
/** 顶层返回值序列化上限（harness 不量 artifact 体积——这道界属于 service/工具层）。 */
export const EVAL_WORKFLOW_SNIPPET_MAX_ARTIFACT_BYTES = 256 * 1024;

export const EvalWorkflowSnippetOutputSchema = z
  .object({
    /** 编译干净且脚本正常 return 为 true；诊断在场或运行失败（超时 / 抛错 / cap）为 false。 */
    ok: z.boolean(),
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    /** 引擎 `log()` 事件按到达序捕获（有界；截断时最后一条是标注）。 */
    logs: z.array(z.string().max(EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS)),
    /** 面向模型的文本：产物序列化 / 诊断列表 / 结构化失败（错误码 + message）。 */
    response: z.string(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type EvalWorkflowSnippetOutput = z.infer<typeof EvalWorkflowSnippetOutputSchema>;

export const EvalWorkflowSnippetOutputJsonSchema = toToolJsonSchema(
  EvalWorkflowSnippetOutputSchema,
);
