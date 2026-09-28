/**
 * 工作流工具的结果卡 display 构造：观察类五件套（GetWorkflowRun / ListWorkflowRuns /
 * EvalWorkflowSnippet / ListSavedWorkflows / ListModels）+ ResumeWorkflowRun 恢复卡。
 *
 * 独立成文件而不是塞进 result-display.ts（已 500 行）：这些构造函数共享同一套
 * 「safeParse 输出 schema → display 侧独立限长 → 超 limit 打 truncated」的骨架，与既有
 * createCreateWorkflowDisplay 同族但自成一块。
 */

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  EvalWorkflowSnippetOutputSchema,
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunOutputSchema,
  LIST_MODELS_TOOL_NAME,
  ListModelsOutputSchema,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsOutputSchema,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsOutputSchema,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunOutputSchema,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS,
  type GetWorkflowRunOutput,
  type GetWorkflowRunToolResultDisplayPayload,
  type ToolResultDisplayPayload,
} from "@lcode/contracts";

import { boundDisplayText } from "./display-text.js";

export function createWorkflowObservationDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  return (
    createGetWorkflowRunDisplay(toolName, output) ??
    createListWorkflowRunsDisplay(toolName, output) ??
    createEvalWorkflowSnippetDisplay(toolName, output) ??
    createSavedWorkflowListDisplay(toolName, output) ??
    createListModelsDisplay(toolName, output) ??
    createResumeWorkflowRunDisplay(toolName, output)
  );
}

function createGetWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== GET_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const actors = data.actors.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS);
  if (actors.length < data.actors.length) truncated = true;

  // 取尾巴：logTail 的价值在「最新进展」，截头不截尾。
  const droppedLogEntries = Math.max(0, data.logTail.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES);
  const logTail = data.logTail
    .slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES)
    .map((entry) => {
      const bounded = boundDisplayText(entry.message, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
      if (bounded.truncated) truncated = true;
      // `at` 原样带上卡（有则带，无则缺席）：卡上的日志年龄与模型面的 `<log_tail>` 同一把尺。
      return {
        sequence: entry.sequence,
        message: bounded.value,
        ...(entry.at === undefined ? {} : { at: entry.at }),
      };
    });
  if (droppedLogEntries > 0) truncated = true;

  let result: string | undefined;
  if (data.result !== undefined) {
    const bounded = boundDisplayText(data.result, WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS);
    if (bounded.truncated) truncated = true;
    result = bounded.value;
  }

  // 卡片上的错误只带 code / message。
  // 输出侧的 `providerStop` 是模型通道的诊断细节，只留在工具文本与输出里；渲染端用
  // packages/shared 的镜像 schema 严格校验每一帧，display 上多一个键就是整条 row 被拒——
  // 这里曾经原样透传 data.error，把一个桌面会话卡在 fault.subscription.recoveryFailed 上；
  // display 还会落进 tool part 的 metadata，所以写错一次就是每次冷启动重现一次。
  const error =
    data.error === undefined ? undefined : { code: data.error.code, message: data.error.message };

  // 情势截面：阶段表与花名册在卡面上各有自己的界（display 不过 result budget），
  // 被裁到就并进同一个 truncated 标记——卡上只该有它真的画出来的那些行。
  // 这几个字段在 schema 上是可选的（为了让情势上线前持久化的老载荷仍能过校验），但构造侧
  // **每次都填**：可选是为读老数据留的门，不是给新调用留的缺口。
  const phases = data.phases?.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES);
  if (phases !== undefined && phases.length < data.phases!.length) truncated = true;
  const subagents = data.subagents.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS);
  if (subagents.length < data.subagents.length || data.subagentsTruncated === true) truncated = true;

  return {
    kind: "get_workflow_run",
    runId: data.runId,
    label: data.label,
    status: data.status,
    ...(data.stopReason === undefined ? {} : { stopReason: data.stopReason }),
    ...(data.possiblyInterrupted === true ? { possiblyInterrupted: true } : {}),
    summary: data.summary,
    generatedAt: data.generatedAt,
    usage: data.usage,
    ...(phases === undefined || phases.length === 0 ? {} : { phases }),
    subagents: subagents.map(toDisplaySubagent),
    health: data.health,
    actors,
    logTail,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * 工具面的嵌套子代理 → 卡面的扁平行。`currentAsk` 里那几件事就是这一行的后半截；
 * 等待原因的自由文本不上卡（卡只需要「等槽位 / 在退避」和还要等多久），其余字段
 * **缺席即缺席**——`0 tool calls` 与「不知道」是两件事。
 */
function toDisplaySubagent(
  subagent: GetWorkflowRunOutput["subagents"][number],
): NonNullable<GetWorkflowRunToolResultDisplayPayload["subagents"]>[number] {
  const ask = subagent.currentAsk;
  return {
    siteId: subagent.siteId,
    ordinal: subagent.ordinal,
    ...(subagent.name === undefined ? {} : { name: subagent.name }),
    state: subagent.state,
    ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
    ...(ask?.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask?.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    ...(ask?.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask?.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask?.lastTool === undefined ? {} : { lastTool: ask.lastTool }),
    ...(subagent.wait === undefined
      ? {}
      : {
          waitCause: subagent.wait.cause,
          ...(subagent.wait.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: subagent.wait.retryAfterMs }),
          ...(subagent.wait.since === undefined ? {} : { waitSince: subagent.wait.since }),
        }),
    ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
    stepsSettled: subagent.stepsSettled,
    stepsFailed: subagent.stepsFailed,
    tokens: subagent.tokens,
    ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
  };
}

function createListWorkflowRunsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_WORKFLOW_RUNS_TOOL_NAME) return undefined;
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  // run 行全部字段都是小数值 / 已有界短文本（label ≤ 80、name ≤ 64），limit 又封顶 50，
  // 直接透传即可——截断语义由输出自身的 truncated 表达。
  return {
    kind: "list_workflow_runs",
    runs: parsed.data.runs,
    ...(parsed.data.truncated === true ? { truncated: true } : {}),
  };
}

function createEvalWorkflowSnippetDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== EVAL_WORKFLOW_SNIPPET_TOOL_NAME) return undefined;
  const parsed = EvalWorkflowSnippetOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  // 诊断限长照 createCreateWorkflowDisplay 同款：条数 slice + 单条 message 截字符。
  const diagnostics = data.diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  if (diagnostics.length < data.diagnostics.length) truncated = true;

  // logs 取尾巴：snippet 的日志按到达序，最新行为在尾部。
  const droppedLogs = Math.max(0, data.logs.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES);
  const logs = data.logs.slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES).map((entry) => {
    const bounded = boundDisplayText(entry, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  });
  if (droppedLogs > 0) truncated = true;

  const boundedResponse = boundDisplayText(data.response, WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS);
  if (boundedResponse.truncated) truncated = true;

  return {
    kind: "eval_workflow_snippet",
    ok: data.ok,
    diagnostics,
    logs,
    response: boundedResponse.value,
    durationMs: data.durationMs,
    ...(truncated ? { truncated: true } : {}),
  };
}

function createSavedWorkflowListDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_SAVED_WORKFLOWS_TOOL_NAME) return undefined;
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const workflows = data.workflows.map((entry) => ({
    name: entry.name,
    description: boundMeta(entry.description),
    whenToUse: boundMeta(entry.whenToUse),
    scope: entry.scope,
    path: entry.path,
    // args 只保留名字：声明细节（类型/描述/默认值）归保存确认窗，列表卡不重复。
    argNames: entry.args === undefined ? [] : Object.keys(entry.args),
  }));

  const invalid = data.invalid?.map((entry) => ({
    path: entry.path,
    reason: boundMeta(entry.reason),
  }));

  return {
    kind: "saved_workflow_list",
    workflows,
    ...(invalid !== undefined && invalid.length > 0 ? { invalid } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * ListModels 的结果卡。
 *
 * 目录行本身全是短 id 与小数值，原样透传即可；providerLabel / disabledReason 是注册表来的
 * 自由文本，走 boundDisplayText。行数按 100 封顶——工具的模型通道有 24k 预算兜着，display
 * 通道没有，一台接了聚合 provider 的机器能列出上千行。截掉就说「未显示全部」，绝不报数字：
 * 目录卡上的数字只该是它真的画出来的那些。
 */
function createListModelsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_MODELS_TOOL_NAME) return undefined;
  const parsed = ListModelsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const models = data.models.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS).map((model) => {
    const providerLabel = boundMeta(model.providerLabel);
    const disabledReason = boundMeta(model.disabledReason);
    return {
      id: model.id,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(providerLabel === undefined ? {} : { providerLabel }),
      reasoningLevels: [...model.reasoningLevels],
      ...(model.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: model.defaultReasoningLevel }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(disabledReason === undefined ? {} : { disabledReason }),
    };
  });
  if (models.length < data.models.length) truncated = true;

  return {
    kind: "list_models",
    // 目录里一条都没标 current 时缺席（同工具输出：会话的选择可能指向一个已删掉的 provider）。
    ...(data.current === undefined ? {} : { current: data.current }),
    models,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * ResumeWorkflowRun 的结果卡。载荷刻意最小 {runId}——恢复卡要传达的就是
 * 「哪个 run 在后台继续」，response 引导文案属模型通道、UI 有自己的本地化词汇表；
 * 无限长面也就没有 truncated 语义。
 */
function createResumeWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== RESUME_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  return { kind: "resume_workflow_run", runId: parsed.data.runId };
}
