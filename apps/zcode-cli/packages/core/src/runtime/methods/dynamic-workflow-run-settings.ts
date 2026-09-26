import { randomUUID } from "node:crypto";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type DynamicWorkflowRunSnapshot,
  type DynamicWorkflowActorModelOverride,
  type TraceContext,
  type WorkflowSettingsAmendMeta,
} from "@zcode/contracts";
import { formatModelPickerValue, uuidv7, type ModelSelection } from "@zcode/shared";
import {
  resolveAmendMaxConcurrency,
  resolveAmendSubagentModelChoice,
} from "../../tool/handlers/amend-workflow-resolve.js";
import { resolveKeptScriptFile } from "../../tool/handlers/amend-workflow-source.js";
import { parseWorkflowSubagentModel } from "../../tool/handlers/model-reference.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import {
  resolveWorkflowDraftName,
  writeWorkflowDraft,
} from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { createRuntimeCommandId } from "../command-queue.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { boundedCompileDiagnostics } from "./dynamic-workflow-run-start.js";

/**
 * GUI「配置」的请求。两项设置守工具的三态：
 * 省略 = 沿用，`null` = 回到默认（会话模型 / 本机上限），值 = 设定。
 */
export interface AmendWorkflowRunSettingsInput {
  runId: string;
  subagentModel?: string | null;
  subagentSelection?: ModelSelection | null;
  maxConcurrency?: number | null;
  traceContext?: TraceContext;
}

/** 拒绝词表与 shared 的 `workflowRunSettingsRejectionReasonSchema` 逐字相同。 */
export type AmendWorkflowRunSettingsRejection =
  | "not_found"
  | "not_configurable"
  | "unchanged"
  | "script_missing"
  | "model_unavailable"
  | "compile_failed"
  | "missing_boundaries"
  | "start_failed";

export type AmendWorkflowRunSettingsResult =
  | { ok: true; runId: string; toolCallId: string; supersededRunId?: string }
  | { ok: false; reason: AmendWorkflowRunSettingsRejection; message?: string };

/** 本 run 的两项设置的归一形：缺席即默认（会话模型 / 本机上限）。 */
interface RunSettings {
  subagentModel?: string;
  subagentSelection?: ModelSelection;
  sessionSelection?: ModelSelection;
  actorModelOverrides?: DynamicWorkflowActorModelOverride[];
  maxConcurrency?: number;
}

/**
 * GUI「配置」：以同一份脚本、新的设置修订一个 run。
 *
 * 它是 `port.amend` 的**第二个调用方**，与 `AmendWorkflow` 工具同构：同一段三态归一
 * （`resolveAmendSubagentModelChoice` / `resolveAmendMaxConcurrency`，不复制）、同一个编译、同一个
 * 后台追踪器（合成一个 AmendWorkflow 描述子）。区别只在：不经模型轮、不开确认窗（用户在弹层里
 * 点「应用」就是同意，脚本也是他批准过的那一份），实参沿用前驱（`inheritArgs`），并用一条排队的
 * controlOnly「设置轮」把这件事记进会话。
 *
 * 顺序固定：直到 `port.amend` 之前的每一步失败都是零副作用——旧 run 照旧在跑、没有新行、没有消息。
 */
export async function amendWorkflowRunSettings(
  this: AgentRuntimeInternal,
  input: AmendWorkflowRunSettingsInput,
): Promise<AmendWorkflowRunSettingsResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const port = this.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.amend !== "function") {
    // 能力只在端口带 amend 与 getScript 时注册；到这里还缺，是接线故障而不是用户输入。
    return { ok: false, reason: "start_failed", message: "dynamic workflow amend unavailable" };
  }

  // (1) 这个 run 必须存在、且属于本会话——命令发给哪个会话，就只能改那个会话自己的 run。
  const snapshot = await port.getTask(input.runId);
  if (snapshot === undefined || snapshot.parentSessionId !== this.sessionId) {
    return { ok: false, reason: "not_found" };
  }
  // (2) 已完成的 run 每个 ask 都会从缓存重放，新设置无处生效；被替代的 run 活的是它的后继。
  if (snapshot.runStatus === "completed" || snapshot.supersededBy !== undefined) {
    return { ok: false, reason: "not_configurable" };
  }
  // (3) 沿用的脚本（「Keeping the predecessor's script」同一条读路）。
  const script =
    typeof port.getScript === "function" ? await port.getScript(input.runId) : undefined;
  if (script === undefined || script.length === 0) {
    return { ok: false, reason: "script_missing" };
  }

  // (4)(5) 两项设置的三态归一，与工具同一段代码。
  const current = runSettingsOfSnapshot(snapshot);
  if (input.subagentModel !== undefined && input.subagentSelection !== undefined) {
    return { ok: false, reason: "model_unavailable", message: "Conflicting model selections" };
  }
  const model =
    input.subagentSelection === undefined
      ? resolveAmendSubagentModelChoice(
          input.subagentModel,
          current.subagentModel,
          this.modelCatalogPort,
        )
      : { ok: true as const, canonical: current.subagentModel };
  if (!model.ok) {
    // 目录缺席时的那句话是写给模型的（「omit subagent_model」），GUI 只要原因码；有目录时的
    // 解析诊断（候选名等）对人同样有用，随 message 走。
    return {
      ok: false,
      reason: "model_unavailable",
      ...(this.modelCatalogPort === undefined ? {} : { message: model.message }),
    };
  }
  let selected: ModelSelection | undefined;
  let canonical = model.canonical;
  if (input.subagentSelection !== undefined) {
    // 结构化选择是速度的唯一来源；不从 legacy picker 串反推未记录的设置。
    selected = input.subagentSelection ?? current.sessionSelection;
    if (selected === undefined || !isAvailableWorkflowSelection(selected, this.modelCatalogPort)) {
      return { ok: false, reason: "model_unavailable" };
    }
    canonical = input.subagentSelection === null ? undefined : formatModelPickerValue(selected);
  } else {
    selected =
      input.subagentModel === null
        ? current.sessionSelection
        : input.subagentModel === undefined
          ? current.subagentSelection
          : undefined;
  }
  const ceiling = port.concurrencyCeiling?.();
  const bound = resolveAmendMaxConcurrency(input.maxConcurrency, current.maxConcurrency, ceiling);
  // 等于天花板的界就是「没有自己的界」：快照只在低于天花板时带 maxConcurrency，两边同一个读法，
  // 「未改」的比较才成立（弹层把步进器推到顶也发 null，这里兜住直接给数的调用方）。
  const nextBound =
    bound.max_concurrency === undefined || bound.max_concurrency === ceiling
      ? undefined
      : bound.max_concurrency;
  const next: RunSettings = {
    ...(canonical === undefined ? {} : { subagentModel: canonical }),
    ...(selected === undefined ? {} : { subagentSelection: selected }),
    ...(current.sessionSelection === undefined
      ? {}
      : { sessionSelection: current.sessionSelection }),
    ...(current.actorModelOverrides === undefined
      ? {}
      : { actorModelOverrides: current.actorModelOverrides }),
    ...(nextBound === undefined ? {} : { maxConcurrency: nextBound }),
  };
  // (6) 什么都没变就不起新 run：一次修订会停下在飞的 run，没有理由为零改动付这个代价。
  const modelChanged =
    next.subagentModel !== current.subagentModel ||
    JSON.stringify(next.subagentSelection) !== JSON.stringify(current.subagentSelection);
  const boundChanged = next.maxConcurrency !== current.maxConcurrency;
  if (!modelChanged && !boundChanged) return { ok: false, reason: "unchanged" };

  // (7) 编译。存下的脚本可能是在更早的 facade 上写的；编不过就停在这里，旧 run 不动。
  const analysis = analyzeScript(script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The stored script of run ${input.runId} has errors:`,
        analysis.diagnostics,
      ),
    };
  }

  // —— 到此为止零副作用。——

  // 新 run 的脚本文件，与工具沿用脚本时同一条规则、
  // 同一段代码：前驱的脚本文件此刻仍是这份字节就继续记它，否则照「不来自文件的脚本」写一份新草稿。
  // 不记的话，模型之后要修订这个 run 就只剩把整份脚本内联再抄一遍这一条路。草稿尽力而为：写不成
  // 即缺席，run 照常起。它是 amend 之前唯一的落盘，留下的至多是一个没人引用的草稿文件。
  const graph = boundGraphOfAnalysis(analysis);
  const keptFile = await resolveKeptScriptFile({
    cwd: this.workingDirectory,
    scriptPath: snapshot.scriptPath,
    script,
  });
  const scriptPath =
    keptFile?.path ??
    (
      await writeWorkflowDraft({
        cwd: this.workingDirectory,
        name: resolveWorkflowDraftName(snapshot.name, graph),
        source: script,
      })
    )?.path;

  // (8) 修订。`settings-` 前缀让日志与卡片分得出它与模型工具调用（`tool_*`）、中枢启动（`launch-`）。
  const toolCallId = `settings-${randomUUID()}`;
  const phaseNames = createWorkflowPhaseNames(graph);
  const phaseAlongside = phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(graph);
  const subagentModel =
    next.subagentModel === undefined
      ? undefined
      : (next.subagentSelection ??
        parseWorkflowSubagentModel(next.subagentModel, this.modelCatalogPort));
  let amended: Awaited<ReturnType<NonNullable<typeof port.amend>>>;
  try {
    amended = await port.amend({
      scriptText: script,
      cwd: this.workingDirectory,
      predecessorRunId: input.runId,
      parentSessionId: this.sessionId,
      toolCallId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(next.maxConcurrency === undefined ? {} : { maxConcurrency: next.maxConcurrency }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      ...(next.sessionSelection === undefined
        ? {}
        : { sessionModelSelection: next.sessionSelection }),
      ...(next.actorModelOverrides === undefined
        ? {}
        : { actorModelOverrides: next.actorModelOverrides }),
      ...(scriptPath === undefined ? {} : { scriptPath }),
      // 重跑的是前驱自己的脚本，它读的正是前驱启动时的实参。
      inheritArgs: true,
      trace: traceContext,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "start_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!amended.ok) {
    return {
      ok: false,
      reason: amended.reason === "run_not_found" ? "not_found" : "missing_boundaries",
    };
  }

  // 名字只取 run 自己的：没起过名的 run 就不带名字，卡片、侧板与通知照任何无名 run 的规矩换用兜底词。
  // 这里曾兜底成 `run <id>`，设置轮的卡片与侧板标题于是成了一串 run id，
  // 而且这个假名会沿修订链一路传下去。
  const trimmedName = snapshot.name?.trim();
  const name = trimmedName === undefined || trimmedName.length === 0 ? undefined : trimmedName;
  const amend: WorkflowSettingsAmendMeta = {
    predecessorRunId: input.runId,
    ...(modelChanged ? { subagentModel: fromTo(current.subagentModel, next.subagentModel) } : {}),
    ...(modelChanged
      ? { subagentSelection: fromTo(current.subagentSelection, next.subagentSelection) }
      : {}),
    ...(boundChanged
      ? { maxConcurrency: fromTo(current.maxConcurrency, next.maxConcurrency) }
      : {}),
    ...(ceiling === undefined ? {} : { ceiling }),
  };

  // (9)(10) 之后的失败只记日志不回滚：新 run 已在飞，可在侧板停下；撤回它反而制造孤儿。
  try {
    // 后台追踪：合成一个 AmendWorkflow 描述子走 executor 的同一条登记（registry、终态 waiter、
    // 结算通知）。`input.name` 喂通知主题，工具名让分派归 "workflow"。
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: AMEND_WORKFLOW_TOOL_NAME,
      input: { run_id: input.runId, ...(name === undefined ? {} : { name }) },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: amended.runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: input.runId,
        runId: amended.runId,
        superseded: amended.supersededRunId !== undefined,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId: amended.runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        ...(() => {
          const display = displayOfAnalysis(analysis);
          return display?.kind === "create_workflow" ? { display } : {};
        })(),
        amend,
      }),
      // 会话此时必已落库（它名下有 run），标题种子不会被用上；给一个诚实的值即可。
      titleInput: name ?? input.runId,
      traceContext,
    });
  } catch (error) {
    this.logger?.error(
      "Workflow settings amended but post-amend bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_amend_failed",
        module: "core.runtime",
        runId: amended.runId,
        toolCallId,
      },
    );
  }

  return {
    ok: true,
    runId: amended.runId,
    toolCallId,
    ...(amended.supersededRunId === undefined ? {} : { supersededRunId: amended.supersededRunId }),
  };
}

/**
 * 设置轮不在命令处理里直接落：主代理可能正在一轮里，user 消息插不进去。排进运行时队列，空闲时
 * 立即跑、忙时等当前轮结束；与通知同优先级，因而先于新 run 的任何通知。
 */
function enqueueSettingsTurn(
  this: AgentRuntimeInternal,
  turn: {
    text: string;
    meta: ReturnType<typeof boundWorkflowLaunchMeta>;
    titleInput: string;
    traceContext: TraceContext;
  },
): void {
  this.enqueueRuntimeCommand({
    branchGeneration: this.branchGeneration,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    inputId: uuidv7(),
    mode: "control-only-turn",
    priority: "next",
    text: turn.text,
    titleInput: turn.titleInput,
    traceContext: turn.traceContext,
    workflowLaunch: turn.meta,
  });
}

function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * 设置轮的模型面规范句（英文，不本地化——它进 provider transcript）。只说改过的设置；两个 `null`
 * 各有一句话。末句劝阻模型再动这个 run：它已经在跑，进展以通知回来。
 */
function buildSettingsMessageText(input: {
  name?: string;
  previous: string;
  runId: string;
  superseded: boolean;
  amend: WorkflowSettingsAmendMeta;
}): string {
  const changes: string[] = [];
  const model = input.amend.subagentModel;
  if (model !== undefined) {
    changes.push(
      model.to === undefined
        ? "its subagents are back on the session model"
        : `its subagents now run on ${model.to} with ${JSON.stringify(input.amend.subagentSelection?.to?.options ?? {})}`,
    );
  }
  const bound = input.amend.maxConcurrency;
  if (bound !== undefined) {
    changes.push(
      bound.to === undefined
        ? "the limit on subagents at once is removed"
        : `at most ${bound.to} of them run at once`,
    );
  }
  const relation = input.superseded ? "supersedes" : "takes over from";
  return [
    `Changed the settings of workflow run ${input.previous}${input.name === undefined ? "" : ` ("${input.name}")`} from the GUI: ${changes.join("; ")}.`,
    `The same script continues as run ${input.runId}, which ${relation} run ${input.previous} and imports everything run ${input.previous} finished as cache.`,
    "Progress and results arrive as background notifications; do not amend, resume or restart it.",
  ].join(" ");
}

/**
 * 快照上的两项设置。两者都「无则缺席」：没指定过模型 = 会话模型，界不低于天花板 = 没有自己的界，
 * 所以缺席就是默认，与 {@link RunSettings} 同一个读法。
 */
function runSettingsOfSnapshot(snapshot: DynamicWorkflowRunSnapshot): RunSettings {
  return {
    ...(snapshot.subagentModel === undefined ? {} : { subagentModel: snapshot.subagentModel }),
    ...(snapshot.subagentSelection === undefined
      ? {}
      : { subagentSelection: snapshot.subagentSelection }),
    ...(snapshot.sessionSelection === undefined
      ? {}
      : { sessionSelection: snapshot.sessionSelection }),
    ...(snapshot.actorModelOverrides === undefined
      ? {}
      : { actorModelOverrides: snapshot.actorModelOverrides }),
    ...(snapshot.maxConcurrency === undefined ? {} : { maxConcurrency: snapshot.maxConcurrency }),
  };
}

function isAvailableWorkflowSelection(
  selection: ModelSelection,
  catalog: AgentRuntimeInternal["modelCatalogPort"],
): boolean {
  const entry = catalog
    ?.listModels()
    .find(
      (candidate) =>
        candidate.providerId === selection.providerId &&
        candidate.modelId === selection.modelId &&
        candidate.disabledReason === undefined,
    );
  if (entry === undefined) return false;
  const level = selection.options?.reasoningLevel;
  const speed = selection.options?.speed;
  return (
    (level === undefined || entry.reasoningLevels.includes(level)) &&
    (speed === undefined ||
      (entry.speeds ?? (entry.defaultSpeed ? [entry.defaultSpeed] : [])).includes(speed))
  );
}
