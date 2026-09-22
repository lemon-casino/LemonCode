// ============================================================
// AmendWorkflow Tool - revise a run: stop it if it is still going, import its finished work, start the revision
// ============================================================
//
// 与 CreateWorkflow 分成两个工具的理由：修订是**另一种动作、另一张卡**——模型不是在启动什么，
// 而是在改一个用户正看着的东西，而且前驱可能仍在跑。两者共用同一个输出形状，所以 executor 的
// 后台追踪、`backgrounded` 契约与 display 载荷只有一份。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";
import { WorkflowActorModelOverridesSchema } from "./workflow-actor-model-config.js";

export const AMEND_WORKFLOW_TOOL_NAME = "AmendWorkflow";

/**
 * 「至多给一个修订脚本」的违规说明。与 `CREATE_WORKFLOW_SOURCE_ERROR` 同一个位置、同一种语气；
 * 与它不同的是两个都不给在这里**合法**——那是「沿用前驱的脚本」。
 */
export const AMEND_WORKFLOW_SOURCE_ERROR =
  "Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor's script unchanged.";

/**
 * 模型面入参。只有 `run_id` 必填，其余每个字段都守同一条规则：**省略即沿用前驱**。`predecessor` 不在这里——那是
 * resolveInput 回填的事实（下面），模型的 JSON schema 不列它。
 */
const AmendWorkflowModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe(
      "ID of the run to amend — from CreateWorkflow's or AmendWorkflow's result, a notification, GetWorkflowRun or ListWorkflowRuns. Any run of this project qualifies, settled or still running; a running run is stopped and superseded by the new one.",
    ),
  /**
   * `script` 与 `path` 都省略 = 沿用前驱存档的脚本：
   * 只改设定的修订不必把几千 token 的脚本再抄一遍。与两个设定同一个生命周期——`resolveInput` 读前驱
   * 的脚本回填进来并盖上 `predecessor.script_inherited`，此后 hook、确认窗与 handler 面对的都是一份
   * 脚本。运行时 schema 仍须接受缺席：hook 改写后 call-runner 会按模型的原始形状二次校验。
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The WHOLE revised workflow script, inline, written against the same facade as CreateWorkflow. Provide this OR `path`, never both — `path` is the usual form. OMIT both to keep the predecessor's script unchanged and change only the settings (max_concurrency, subagent_model, name). Named subagents whose asks you left byte-identical settle from the predecessor's recorded results at zero token cost; the first changed or new ask runs live, and from that point everything runs live.",
    ),
  /**
   * 修订的常态来源：前驱的脚本文件就地改一行，
   * 再把同一个路径交回来。内联仍然收，但它要把整段脚本再流一遍——而那正是这条路径要省掉的。
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The revised script's file, relative to the working directory or absolute — usually the predecessor's own script file, which the errored notification and GetWorkflowRun name. Provide this OR `script`, never both; omit both when the script is not changing. Edit that file in place and pass the same path back: a revision then costs one Edit instead of a second copy of the whole script. Submitting a file whose bytes are unchanged is refused (`script_unchanged`) unless the call also changes `max_concurrency` or `subagent_model`.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Optional display label for the new run. Defaults to the predecessor's name."),
  /**
   * 三态：省略 = 沿用前驱的上界、
   * `null` = 解除（回到天花板）、数 = 设定（钳到天花板之下）。三态只活到 `resolveInput`：那里把它
   * 归一成一个数或缺席，确认窗与 handler 读到的就是将要生效的值。运行时 schema 保留 `nullable`
   * 是因为 hook 改写后 call-runner 会二次校验模型的原始形状。
   */
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Upper bound on how many subagents work at the same time in the new run. Three states: OMIT the field to keep the predecessor's limit; pass null to remove that limit (run at this machine's default); pass a number to set one. Set a number ONLY when the user asks to limit parallelism — never on your own initiative and never in response to provider rate limits or errors, which the runtime already adapts to. A value above what this machine allows is lowered to that maximum.",
    ),
  /**
   * 三态，与 `max_concurrency` 逐字同规：
   * 省略 = 沿用前驱的选型（`resolveInput` 从前驱快照回填后**重新解析一次**，好让一个已经被
   * 删掉的模型现在就失败，而不是拖到子代理第一次开口）、`null` = 清除（回到会话模型）、
   * 字符串 = 设定。三态只活到 `resolveInput`：那里归一成一个规范形字符串或缺席。
   */
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Model for the workflow's subagents in the new run, as `providerId/modelId` or a bare model id (optionally `$reasoningLevel`). Set it ONLY when the user asks for the subagents to run on a specific model; pass the name the user used, and if the tool answers that it cannot resolve it, pick from the listed ids or call ListModels. The main agent (you) keeps the session model regardless. Three states: OMIT to keep the predecessor's choice; null to return to the session model; a string to set one.",
    ),
});

/**
 * resolveInput 回填的前驱事实（第 2 步）。
 *
 * 权限判定（本会话的 run 免确认）与确认窗（「仍在运行，将被停止」）都读它，而两处都在
 * handler 之前、且必须同步——所以由 resolveInput（异步、全流程唯一一次读端口）算好放进入参。
 * 归一化**无条件覆盖**：模型伪造它是无效的（saved.path 的同一条先例）。
 */
export const AmendWorkflowPredecessorSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    stop_reason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    owned_by_this_session: z.boolean(),
    /**
     * 这次调用 `script` 与 `path` 都没给，入参里的 `script` 是 resolveInput 从前驱存档读来的。只有「在场即真」一种值：
     * 确认窗据它在 lineage 行说「脚本不变」，handler 据它换成「沿用」的文案与诊断首句。与整块一起
     * 被无条件覆盖，模型伪造无效。
     */
    script_inherited: z.literal(true).optional(),
  })
  .strict();

export type AmendWorkflowPredecessor = z.infer<typeof AmendWorkflowPredecessorSchema>;

/**
 * 运行时入参：模型面那些键 + 回填的 `predecessor` 与 `script_line_offset`。`.strict()`：
 * `resume_from` 这类旧拼写在这里也是可见错误。
 */
export const AmendWorkflowInputSchema = AmendWorkflowModelInputSchema.extend({
  predecessor: AmendWorkflowPredecessorSchema.optional(),
  /**
   * 正文行 → 文件行的偏移，`path` 文件带 `/* zcode-workflow` 块时才非零。与 `predecessor`
   * 同一个姿态：解析结果，不是可填的参数，模型的 JSON schema 不列它。
   */
  script_line_offset: z.number().int().nonnegative().optional(),
  /** Approval UI overrides; never authored by the model. */
  actor_model_overrides: WorkflowActorModelOverridesSchema.optional(),
}).strict();

export type AmendWorkflowInput = z.infer<typeof AmendWorkflowInputSchema>;

/** 交给模型的 JSON schema：不含 `predecessor`，也不含 `script_line_offset`。 */
export const AmendWorkflowInputJsonSchema = toToolJsonSchema(
  AmendWorkflowModelInputSchema.strict(),
);
