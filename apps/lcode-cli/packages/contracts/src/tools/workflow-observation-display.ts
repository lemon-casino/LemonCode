import { z } from "zod";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS,
  GetWorkflowRunActorSchema,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentLastToolSchema,
  GetWorkflowRunUsageSchema,
} from "./get-workflow-run.js";
import {
  ListWorkflowRunsRunSchema,
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

/**
 * 观察类工作流工具（GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
 * ListSavedWorkflows / ListModels）的结果卡 display 载荷。
 *
 * 限长常量与构造侧（core 的 workflow-observation-display.ts）一一对应：display 不经过
 * result budget，文本字段与数组长度必须在进入实时事件和持久化 metadata 前独立限长，
 * 超限由构造侧打 truncated 标记。
 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES = 40;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS = 1_024;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS = 32;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS = 4_000;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS = 2_048;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS = 50;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS = 32;
/** 目录卡一次最多画几行模型（超出由构造侧 slice 并打 truncated）。 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS = 100;
/** 情势截面在卡上的界，与工具面同值（{@link GET_WORKFLOW_RUN_ROSTER_LIMITS}）。 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES = GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS =
  GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents;

/**
 * 卡上的一个子代理。刻意是**扁平行**而不是工具输出的嵌套形状：卡画的是一行，
 * `currentAsk` 里那几件事（派去干什么、第几轮、最后碰了哪个工具）就是这一行的后半截，
 * 多一层嵌套只会让渲染端先解构再拼回来。
 *
 * 枚举集与工具面**逐字相同且闭合**：消费 bundle 会拒收未知枚举值（曾因此让一整条
 * 订阅失效），所以这两处永远一起改。
 */
export const getWorkflowRunToolResultDisplaySubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    /** 当前 ask 的任务摘要与进度读数（缺席 = 不知道，绝不是 0）。 */
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
    /** 在等什么（原因文本不上卡：卡只需要「等槽位」还是「在退避」和还要等多久）。 */
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

export const getWorkflowRunToolResultDisplayLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS),
    // 事件落 journal 的时刻（epoch ms），与工具输出的 `logTail[].at` 同源；卡上的年龄对
    // `generatedAt` 算。可选：情势截面之前的载荷没有它，与 shared 侧同步为可选。
    at: z.number().optional(),
  })
  .strict();

/**
 * 工具卡上的结构化失败：**只有 code 与 message**，刻意不复用工具输出的
 * `GetWorkflowRunErrorSchema`。
 *
 * 两个通道的读者不同：输出是模型在读，它需要 `providerStop` 才知道该修什么；display 是
 * 渲染端在读，而渲染端用 packages/shared 的镜像 schema 严格校验每一帧。复用等于让
 * display 跟着输出长字段，镜像没跟上就是整条 row 被拒、会话恢复 fail-closed。
 * 这份定义是那份镜像的对侧，两边逐字段同步。
 */
export const getWorkflowRunToolResultDisplayErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

/**
 * GetWorkflowRun 的结果卡载荷。预算 / actor 直接复用工具输出 schema（纯小数值或已有界的
 * 小结构）；错误走上面那份 display 专用 schema；logTail 与 result 在 display 侧独立限长——
 * 输出侧的 2048 字符/条与 artifact 序列化上限属于模型通道，两道界互不替代。
 */
export const getWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    /** `status === "stopped"` 才在场。 */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    /**
     * 情势截面：那一句摘要、快照时刻、阶段表、花名册、健康。
     *
     * 五个字段**全部可选**，尽管构造侧每次都填。理由是**已经躺在库里的 transcript**：
     * 情势截面上线之前持久化的 `get_workflow_run` 载荷没有这些键，而 display schema 是
     * strict 的——把它们设成必填，等于让升级后打开的每一条历史会话的这张卡整块校验失败、
     * 退化成纯文本。文本兜底只针对**完全没有载荷**的老行，不针对有载荷的。
     *
     * `generatedAt` 是卡上所有「多久以前」的基准：必须对快照时刻算，而不是对渲染时的
     * `Date.now()`——一条三天前的 transcript 重新打开时，卡上的年龄仍是当时那个年龄。
     */
    summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS).optional(),
    generatedAt: z.number().optional(),
    usage: GetWorkflowRunUsageSchema,
    phases: z
      .array(GetWorkflowRunPhaseSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES)
      .optional(),
    subagents: z
      .array(getWorkflowRunToolResultDisplaySubagentSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS)
      .optional(),
    health: GetWorkflowRunHealthSchema.optional(),
    actors: z.array(GetWorkflowRunActorSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS),
    logTail: z
      .array(getWorkflowRunToolResultDisplayLogEntrySchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    result: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS).optional(),
    error: getWorkflowRunToolResultDisplayErrorSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/** ListWorkflowRuns 的结果卡载荷：run 行直接复用输出 schema（limit 已封顶 50）。 */
export const listWorkflowRunsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(ListWorkflowRunsRunSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * EvalWorkflowSnippet 的结果卡载荷。诊断复用 create_workflow 的 display 诊断 schema
 * （同一 TS 诊断形状，同一道限长）；logs 取尾巴、response 独立限长。
 */
export const evalWorkflowSnippetToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    logs: z
      .array(z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS))
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    response: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * ListSavedWorkflows 的结果卡载荷。根因：v4 wire 上 output.text 是 formatModelContent
 * 的 XML 风格投影，UI 侧 JSON 探针永不命中（掉进 raw JSON 兜底卡）——结构化列表必须走
 * 本 display 通道。description / whenToUse 独立限长；args 只保留名字（声明细节归确认窗）。
 */
export const savedWorkflowListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            whenToUse: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
 * ListModels 的结果卡载荷。根因与 saved_workflow_list 同一条：v4 wire 上 output.text 是
 * formatModelContent 的 `<models>` 投影，UI 侧 JSON 探针永不命中——结构化目录只能走本通道。
 *
 * 字段就是工具输出本身（读侧要画的三件事「有哪些、来自哪里、哪个是当前」全在里面），
 * 多一个 truncated。providerLabel / disabledReason 是注册表来的自由文本，display 不过 result
 * budget，必须在这里独立限长；其余是短 id 与小数值，原样透传。
 */
export const listModelsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_models"),
    /** 会话此刻的模型（规范形）；目录里一条都对不上时缺席。 */
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS),
    truncated: z.boolean().optional(),
  })
  .strict();

export type GetWorkflowRunToolResultDisplayPayload = z.infer<
  typeof getWorkflowRunToolResultDisplayPayloadSchema
>;
export type ListWorkflowRunsToolResultDisplayPayload = z.infer<
  typeof listWorkflowRunsToolResultDisplayPayloadSchema
>;
export type EvalWorkflowSnippetToolResultDisplayPayload = z.infer<
  typeof evalWorkflowSnippetToolResultDisplayPayloadSchema
>;
export type SavedWorkflowListToolResultDisplayPayload = z.infer<
  typeof savedWorkflowListToolResultDisplayPayloadSchema
>;
export type ListModelsToolResultDisplayPayload = z.infer<
  typeof listModelsToolResultDisplayPayloadSchema
>;

/**
 * ResumeWorkflowRun 的结果卡载荷。
 *
 * 刻意最小 `{runId}`：恢复卡要传达的信息就是「哪个 run 在后台继续」——response 引导文案是
 * 模型通道的话术，UI 有自己的本地化词汇表，多带字段只增 wire 字节没有消费者。构造侧
 * safeParse 输出 schema 失败即回 undefined（走文本兜底），与上面四个构造函数同一骨架。
 */
export const resumeWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ResumeWorkflowRunToolResultDisplayPayload = z.infer<
  typeof resumeWorkflowRunToolResultDisplayPayloadSchema
>;
