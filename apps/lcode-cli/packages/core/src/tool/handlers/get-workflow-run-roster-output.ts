// ============================================================
// 端口的情势截面 → GetWorkflowRun 输出的情势截面
// ============================================================
//
// 两侧字段同名同义，这里**仍然逐字段搬**而不是原样透传：输出 schema 是 strict 的，端口哪天
// 多长出一个字段，透传就会让整个工具调用在 runtimeOutputSchema 校验处失败。逐字段搬等于把
// 「模型面看得到什么」写死在一处，端口演进不会从背后改变它。
//
// 可选字段一律 `...(x === undefined ? {} : { x })`：显式的 `undefined` 值与缺席在
// `toEqual` 和 JSON 序列化里是两件事，而模型面的契约是「不知道就没有这个键」。

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentView,
  DynamicWorkflowRunSubagentWait,
  GetWorkflowRunHealth,
  GetWorkflowRunPhase,
  GetWorkflowRunSubagent,
  GetWorkflowRunSubagentAsk,
} from "@lcode/contracts";
import { GET_WORKFLOW_RUN_ROSTER_LIMITS } from "@lcode/contracts";

export function toGetWorkflowRunPhases(
  phases: readonly DynamicWorkflowRunPhaseView[] | undefined,
): GetWorkflowRunPhase[] | undefined {
  // 脚本没声明阶段、也一个都没进过 ⇒ 整字段缺席（空数组读起来像「阶段表是空的」）。
  if (phases === undefined || phases.length === 0) return undefined;
  return phases.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases).map((phase) => ({
    name: phase.name,
    state: phase.state,
    rounds: phase.rounds,
    nodesSettled: phase.nodesSettled,
    nodesRunning: phase.nodesRunning,
    ...(phase.enteredAt === undefined ? {} : { enteredAt: phase.enteredAt }),
    ...(phase.exitedAt === undefined ? {} : { exitedAt: phase.exitedAt }),
  }));
}

/**
 * 花名册按 {@link GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents} 截断，并把「截过」说出口：
 * 一个静默少掉十几行的花名册读起来像「这个 run 只有 64 个子代理」，而那是一句假话。
 */
export function toGetWorkflowRunSubagents(subagents: readonly DynamicWorkflowRunSubagentView[]): {
  subagents: GetWorkflowRunSubagent[];
  truncated: boolean;
} {
  const kept = subagents.slice(0, GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents);
  return {
    subagents: kept.map((subagent) => ({
      siteId: subagent.siteId,
      ordinal: subagent.ordinal,
      ...(subagent.name === undefined ? {} : { name: subagent.name }),
      state: subagent.state,
      ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
      ...(subagent.currentAsk === undefined
        ? {}
        : { currentAsk: toCurrentAsk(subagent.currentAsk) }),
      ...(subagent.wait === undefined ? {} : { wait: toWait(subagent.wait) }),
      ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
      stepsSettled: subagent.stepsSettled,
      stepsFailed: subagent.stepsFailed,
      tokens: subagent.tokens,
      ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
      ...(subagent.lastDeliveredAt === undefined
        ? {}
        : { lastDeliveredAt: subagent.lastDeliveredAt }),
    })),
    truncated: kept.length < subagents.length,
  };
}

function toCurrentAsk(ask: DynamicWorkflowRunSubagentAsk): GetWorkflowRunSubagentAsk {
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(ask.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    // turn / toolCalls 缺席读作「不知道」，`0` 读作「一个工具都没调过」——老 journal 上
    // 没有 node-progress，这两件事必须可分辨，所以这里绝不 `?? 0`。
    ...(ask.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask.activity === undefined ? {} : { activity: ask.activity }),
    ...(ask.phase === undefined ? {} : { phase: ask.phase }),
    ...(ask.queue === undefined ? {} : { queue: ask.queue }),
    ...(ask.lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: ask.lastTool.name,
            ...(ask.lastTool.target === undefined ? {} : { target: ask.lastTool.target }),
            ...(ask.lastTool.at === undefined ? {} : { at: ask.lastTool.at }),
          },
        }),
  };
}

function toWait(wait: DynamicWorkflowRunSubagentWait): NonNullable<GetWorkflowRunSubagent["wait"]> {
  return {
    cause: wait.cause,
    ...(wait.reason === undefined ? {} : { reason: wait.reason }),
    ...(wait.retryAfterMs === undefined ? {} : { retryAfterMs: wait.retryAfterMs }),
    ...(wait.attempt === undefined ? {} : { attempt: wait.attempt }),
    ...(wait.nextRetryAt === undefined ? {} : { nextRetryAt: wait.nextRetryAt }),
    ...(wait.since === undefined ? {} : { since: wait.since }),
  };
}

export function toGetWorkflowRunHealth(health: DynamicWorkflowRunHealth): GetWorkflowRunHealth {
  return {
    ...(health.lastProgressAt === undefined ? {} : { lastProgressAt: health.lastProgressAt }),
    ...(health.stalledSince === undefined ? {} : { stalledSince: health.stalledSince }),
    ...(health.concurrency === undefined
      ? {}
      : {
          concurrency: {
            effective: health.concurrency.effective,
            cap: health.concurrency.cap,
            ...(health.concurrency.reason === undefined
              ? {}
              : { reason: health.concurrency.reason }),
            ...(health.concurrency.since === undefined ? {} : { since: health.concurrency.since }),
          },
        }),
    consecutiveFailures: health.consecutiveFailures,
    cachedSteps: health.cachedSteps,
    // 为 0 时缺席：终态 run 没有残留行是常态，而 `leftover_running=0` 读起来像一件发生过的事。
    ...(health.leftoverRunning === undefined || health.leftoverRunning === 0
      ? {}
      : { leftoverRunning: health.leftoverRunning }),
    pendingQuestionsKnown: health.pendingQuestionsKnown,
  };
}
