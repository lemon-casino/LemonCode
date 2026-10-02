/**
 * GetWorkflowRun 工具卡的**子代理花名册**（情势截面的另一半，阶段轨与健康行在
 * get-workflow-run-situation.tsx）。
 *
 * 一行的读法与模型面
 * （apps/lcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts）同一句话：
 * 「谁 · 在哪 · 什么相位 · 在哪个阶段 · 正在做什么 · 花了多少 token」，其中「正在做什么」
 * 按相位分叉——在跑的说它的进度与最后一个工具，在等的说等什么、还要等多久，停驻的说等哪个
 * 问题。这正是这张卡存在的理由：一眼看出谁卡住了。
 *
 * 载荷是**扁平行**（没有 `currentAsk` 嵌套），所以「有没有一次在飞的 ask」由那几个读数是否
 * 在场推出来；缺席一律不画，绝不用 0 顶替不知道。
 */

import type { ToolCallGetWorkflowRunDisplay } from "@lcode/shared/lcode-protocol-v4";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import {
  workflowActivityText,
  workflowActivityTiming,
} from "@/components/workflow-timeline/WorkflowExecutionActivity.js";
import { workflowNodeActivity } from "@/components/workflow-timeline/timeline-activity.js";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import {
  formatWorkflowAge,
  formatWorkflowDuration,
  formatWorkflowTimestamp,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import {
  SITUATION_BLOCK_CLASS,
  SITUATION_ROW_CLASS,
} from "@/ToolCallBlocks/renderers/get-workflow-run-situation.js";

type WorkflowRunSubagentView = NonNullable<ToolCallGetWorkflowRunDisplay["subagents"]>[number];
type FormatMessage = ReturnType<typeof useLCodeIntl>["intl"]["formatMessage"];

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";
const ACTIVITY_PREFIX = "chat.toolCall.workflow.activity.";

/**
 * 相位词的语义色。词永远在场，颜色只是第二通道（DESIGN：状态不能只靠颜色）：
 * 在动的用活动色 warning，等待与终态未完结居中，完成 success、失败 destructive。
 * `parked` 也用活动色——它在等一个人回答，是需要注意的状态，不是安静的空闲。
 */
const SUBAGENT_STATE_TEXT: Record<WorkflowRunSubagentView["state"], string> = {
  idle: "text-foreground-subtlest",
  executing: "text-warning",
  waiting: "text-foreground-subtle",
  parked: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  unfinished: "text-foreground-subtle",
};

export function WorkflowRunSubagentRoster({
  subagents,
  generatedAt,
}: {
  subagents: readonly WorkflowRunSubagentView[];
  generatedAt: number | undefined;
}) {
  const { intl } = useLCodeIntl();
  // 空花名册什么也不画：还没造出子代理是一件不需要一整块区域来说的事。
  if (subagents.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-subagents">
      {subagents.map((subagent) => {
        const activity = subagentActivity(subagent, generatedAt, intl.formatMessage);
        return (
          <div className="min-w-0 space-y-0.5" key={`${subagent.siteId}@${subagent.ordinal}`}>
            <div className={`${SITUATION_ROW_CLASS} text-ui-sm`}>
              {/* 匿名子代理不合成兜底名：留空，地址仍然把它认出来。 */}
              {subagent.name === undefined ? null : (
                <span className="min-w-0 break-words text-foreground">{subagent.name}</span>
              )}
              <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
                {subagent.siteId}@{subagent.ordinal}
              </span>
              <span className={`shrink-0 ${SUBAGENT_STATE_TEXT[subagent.state]}`}>
                {intl.formatMessage({ id: `${I18N_PREFIX}subagent.state.${subagent.state}` })}
              </span>
              {subagent.phaseName === undefined ? null : (
                <span className="min-w-0 break-words text-foreground-subtle">
                  {intl.formatMessage(
                    { id: `${I18N_PREFIX}subagent.phase` },
                    { name: subagent.phaseName },
                  )}
                </span>
              )}
              {activity.map((cell) => (
                <span className="min-w-0 break-words text-foreground-subtle" key={cell}>
                  {cell}
                </span>
              ))}
              {subagent.tokens > 0 ? (
                <span className="shrink-0 tabular-nums text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.usage.tokens" },
                    { tokens: formatWorkflowTokenCount(subagent.tokens) },
                  )}
                </span>
              ) : null}
            </div>
            {subagent.instructionsHead === undefined ||
            subagent.instructionsHead.length === 0 ? null : (
              // 任务行从属于上一行，不是新的一行事实：缩进而不是另起一格。
              <p className="min-w-0 break-words pl-3 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: `${I18N_PREFIX}subagent.task` },
                  { task: subagent.instructionsHead },
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 那几个进度读数任意一个在场，就说明这一行背后有一次 ask（扁平载荷没有 `currentAsk` 标记）。 */
function hasCurrentAsk(subagent: WorkflowRunSubagentView): boolean {
  return (
    subagent.askPhase !== undefined ||
    subagent.startedAt !== undefined ||
    subagent.turn !== undefined ||
    subagent.toolCalls !== undefined ||
    subagent.lastTool !== undefined ||
    subagent.activity !== undefined ||
    subagent.instructionsHead !== undefined
  );
}

function subagentActivity(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  const ended = subagent.state === "unfinished" || subagent.state === "done" || subagent.state === "failed";
  // 新字段明确 admission/暂停；旧卡保留七态原词和历史统计，缺相位时不额外宣称实时执行。
  const phase = subagent.askPhase ?? (subagent.state === "waiting" ? "waiting" : undefined);
  const activity = workflowNodeActivity({
    phase,
    queue: subagent.queue,
    activity: subagent.activity,
    toolCalls: subagent.toolCalls,
    ...(subagent.waitCause === undefined ? {} : {
      wait: {
        cause: subagent.waitCause,
        since: subagent.waitSince,
        attempt: subagent.retryAttempt,
        reason: subagent.waitReason,
        nextRetryAt: subagent.nextRetryAt,
      },
    }),
  }, { ended, asking: subagent.state === "parked", deliveredAt: subagent.lastDeliveredAt });
  const cells: string[] = [];
  if (subagent.state === "parked" && subagent.parkedOn !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.parkedOn` }, { qid: subagent.parkedOn }));
  } else if (subagent.state === "unfinished" && hasCurrentAsk(subagent)) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.inFlightAtStop` }));
  } else if (!ended && (hasCurrentAsk(subagent) || subagent.state === "waiting")) {
    cells.push(workflowActivityText(activity, formatMessage, generatedAt));
  }
  const timing = workflowActivityTiming(activity, generatedAt);
  if (timing !== undefined) {
    cells.push(`${formatMessage({ id: `${ACTIVITY_PREFIX}${timing.sinceKey}` })}: ${formatWorkflowTimestamp(timing.since)}`);
    if (timing.elapsed !== undefined)
      cells.push(`${formatMessage({ id: `${ACTIVITY_PREFIX}${timing.elapsedKey}` })}: ${timing.elapsed}`);
  }
  if ((activity.kind === "slot" || activity.kind === "backoff") && activity.toolName !== undefined) {
    cells.push(workflowActivityText({ kind: "tool", toolName: activity.toolName }, formatMessage, generatedAt));
  }
  if (activity.reason !== undefined) cells.push(throttleReasonLabel(activity.reason, formatMessage));
  // 老卡只带相对重试等待时仍按生成截面显示；不能换成 Date.now() 或用 observedAt 充当生成时刻。
  if (activity.kind === "backoff" && subagent.nextRetryAt === undefined && subagent.retryAfterMs !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.retryIn` }, {
      duration: formatWorkflowDuration(subagent.retryAfterMs),
    }));
  }
  // 等待分支原来提前返回，抹掉了同一 ask 的成功请求/并行工具；历史统计与当前活动分别追加。
  cells.push(...observedCells(subagent, generatedAt, formatMessage));
  if (cells.length === 0 || !hasCurrentAsk(subagent)) cells.push(...settledCells(subagent, formatMessage));
  return cells;
}

function observedCells(
  subagent: WorkflowRunSubagentView,
  generatedAt: number | undefined,
  formatMessage: FormatMessage,
): string[] {
  const cells: string[] = [];
  if (subagent.state === "executing" && (subagent.askPhase === "executing" || subagent.askPhase === "repairing" || subagent.askPhase === "nudged")) {
    const onStep = formatWorkflowAge(generatedAt, subagent.startedAt);
    if (onStep !== undefined)
      cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.onStep` }, { age: onStep }));
  }
  if (subagent.turn !== undefined) {
    cells.push(formatMessage({ id: `${I18N_PREFIX}subagent.turn` }, { count: subagent.turn }));
  }
  const activity = subagent.activity;
  if (activity !== undefined)
    cells.push(`${formatMessage({ id: `${ACTIVITY_PREFIX}requestsCompleted` })}: ${activity.requestsCompleted}`);
  for (const [key, timestamp] of [
    ["observedAt", activity?.observedAt],
    ["lastRequestCompletedAt", activity?.lastRequestCompletedAt],
    ["deliveredAt", subagent.lastDeliveredAt],
  ] as const) {
    if (timestamp === undefined) continue;
    const age = formatWorkflowAge(generatedAt, timestamp);
    const value = age === undefined ? formatWorkflowTimestamp(timestamp) : formatMessage({ id: `${I18N_PREFIX}age` }, { age });
    cells.push(`${formatMessage({ id: `${ACTIVITY_PREFIX}${key}` })}: ${value}`);
  }
  const toolCalls = activity?.toolCalls ?? subagent.toolCalls;
  if (toolCalls !== undefined) {
    cells.push(formatMessage(
      { id: `${I18N_PREFIX}subagent.${toolCalls === 1 ? "toolCallsOne" : "toolCalls"}` },
      { count: toolCalls },
    ));
  }
  if (subagent.lastTool !== undefined) {
    const { name, target, at } = subagent.lastTool;
    const age = formatWorkflowAge(generatedAt, at);
    cells.push([
      formatMessage({ id: `${I18N_PREFIX}subagent.lastTool` }, { name }),
      target,
      age === undefined ? undefined : formatMessage({ id: `${I18N_PREFIX}age` }, { age }),
    ].filter((part): part is string => part !== undefined && part.length > 0).join(" "));
  }
  return cells;
}

function settledCells(subagent: WorkflowRunSubagentView, formatMessage: FormatMessage): string[] {
  if (subagent.stepsSettled === 0 && subagent.stepsFailed === 0) return [];
  const cells = [
    formatMessage(
      { id: `${I18N_PREFIX}subagent.${subagent.stepsSettled === 1 ? "stepsOne" : "steps"}` },
      { count: subagent.stepsSettled },
    ),
  ];
  if (subagent.stepsFailed > 0) {
    cells.push(
      formatMessage({ id: `${I18N_PREFIX}subagent.stepsFailed` }, { count: subagent.stepsFailed }),
    );
  }
  return cells;
}
