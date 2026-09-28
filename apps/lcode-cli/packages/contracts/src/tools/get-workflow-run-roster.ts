// ============================================================
// GetWorkflowRun 的**情势截面** schema：阶段 / 子代理 / 健康
// ============================================================
// 从 get-workflow-run.ts 拆出，理由与端口侧 dynamic-workflow-run-roster.port.ts 同一条：
// 那份文件已接近 oxlint 的 max-lines 上限，而这三组 schema 自成一块。公开面不变——
// get-workflow-run.ts 原地再导出这里的每一个名字，`@lcode/contracts` 的导入路径逐字不动。
//
// 这里是端口类型（DynamicWorkflowRunPhaseView / …SubagentView / …Health）的**逐字段镜像**，
// 只多了 zod 的界。两侧必须同步：端口是读面的事实，这里是模型面的契约，缺一个字段就意味着
// 一件已经查出来的事实到不了模型。

import { z } from "zod";

/**
 * 情势截面的界。每一条都与已有的某条界同值，不另起一套：
 * 阶段数与阶段名随 reducer 的 `WORKFLOW_RUNS_LIMITS.maxPhases` / `maxPhaseNameLength`，
 * 指令头与工具名/目标随引擎侧的 `INSTRUCTIONS_HEAD_MAX_CHARS` / `LAST_TOOL_TARGET_MAX_CHARS`。
 */
export const GET_WORKFLOW_RUN_ROSTER_LIMITS = {
  /** 阶段表的行数上界（与 reducer 的 maxPhases 同值）。 */
  maxPhases: 32,
  maxPhaseNameLength: 128,
  /**
   * 花名册的行数上界。刻意高于阶段表：一次 50 路 fan-out 是平常事，而读者问的正是
   * 「谁在干什么」。超出这条界时整块被裁，并由 `subagentsTruncated` 说明裁过——
   * 一个静默少掉 18 行的花名册读起来像「只有 64 个子代理」。
   */
  maxSubagents: 64,
  maxActorNameLength: 128,
  /** 一次 ask 的任务摘要（`node-queued` 的 `instructionsHead`）。 */
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
  /** `node-waiting` 的自由文本原因（退避里的 provider 错误一句话）。 */
  maxWaitReasonLength: 240,
} as const;

/** 一个阶段在情势截面里的处境（端口 `DynamicWorkflowRunPhaseView` 的镜像）。 */
export const GetWorkflowRunPhaseSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength),
    /** `ahead` = 脚本声明了它但控制流还没到，也是唯一 `rounds: 0` 的状态。 */
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    /** 最近一次进入 / 离开的时刻（epoch ms）。事件无时间戳时缺席，绝不给 0。 */
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

/** 一次 ask 里最近被观察到的工具调用。`target` 是线索（路径 / 命令头），不是入参全文。 */
export const GetWorkflowRunSubagentLastToolSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolNameLength),
    target: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolTargetLength).optional(),
    at: z.number().optional(),
  })
  .strict();

/**
 * 子代理此刻正在跑的那一次 ask。`turn` / `toolCalls` **缺席读作「不知道」**，`0` 读作
 * 「一个工具都没调过」——老 journal 没有 `node-progress`，两者必须可分辨。
 */
export const GetWorkflowRunSubagentAskSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    actorSeq: z.number().int().nonnegative().optional(),
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
  })
  .strict();

/** 当前 ask 正在等什么。`slot` = 等进程级准入闸门；`backoff` = runner 在退避重试。 */
export const GetWorkflowRunSubagentWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    since: z.number().optional(),
  })
  .strict();

/**
 * 花名册里的一个子代理（端口 `DynamicWorkflowRunSubagentView` 的镜像）。
 *
 * `state` 的七个词是闭集，且读的顺序就是写的顺序（端口注释有完整判定链）：run 活着时
 * `parked` → `waiting` → `executing` → `failed` → `idle`，run 终态时只剩
 * `unfinished` → `failed` → `done`。
 */
export const GetWorkflowRunSubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    currentAsk: GetWorkflowRunSubagentAskSchema.optional(),
    wait: GetWorkflowRunSubagentWaitSchema.optional(),
    /** 它停在哪个问题上；`health.pendingQuestionsKnown` 为假的那次读永不在场。 */
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

/**
 * run 级并发现状。**整个对象只在被压到自己那条界以下时在场**：跑满自己那条界的 run 没有
 * 可说的，而它在场就等于「正被限着」。
 */
export const GetWorkflowRunConcurrencyHealthSchema = z
  .object({
    effective: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    since: z.number().optional(),
  })
  .strict();

/** run 整体还在不在动（端口 `DynamicWorkflowRunHealth` 的镜像）。 */
export const GetWorkflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: GetWorkflowRunConcurrencyHealthSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    /** 仅终态 run：还标着 `running` 的节点行数（进程死在它们下面）。为 0 时缺席。 */
    leftoverRunning: z.number().int().positive().optional(),
    /**
     * 这次读能不能回答「有没有问题在等答案」。为假时 `pendingQuestions` 整字段缺席，
     * 且没有任何子代理会被报成 `parked`——「没有人在等」与「不知道」是两个不同的事实。
     */
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

export type GetWorkflowRunPhase = z.infer<typeof GetWorkflowRunPhaseSchema>;
export type GetWorkflowRunSubagent = z.infer<typeof GetWorkflowRunSubagentSchema>;
export type GetWorkflowRunSubagentAsk = z.infer<typeof GetWorkflowRunSubagentAskSchema>;
export type GetWorkflowRunHealth = z.infer<typeof GetWorkflowRunHealthSchema>;
