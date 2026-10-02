import type { ScriptLoc } from "../compiler/compile.js";
import type { IssueEvent, SettleEvent } from "./causality-order-types.js";
import type { AnalysisCore, CoreAskSite } from "./core.js";

/** Source facts only: absence of a data edge is not proof that work is independent. */
export interface WorkflowOrchestrationAdvice {
  code: "await-before-later-asks" | "join-before-per-item-work";
  line: number;
  column: number;
  waitingOn: ScriptLoc[];
  delayed: ScriptLoc[];
  message: string;
}

const MIN_BRANCHES = 2;
const DEPENDENCY_CAUTION =
  "Check file, permission, actor-context and external-effect dependencies first; keep required safety ordering and same-actor FIFO.";

/**
 * 窄投影，复用唯一解释器的 trace / taint，不重新扫描 AST 或推导一套 CFG。
 * 首批只认根路径的一次调用与紧随屏障、下次等待前的 ask。跨分支、循环、helper、strand
 * 或 may 屏障一律不猜；宁可少提示，也不把调度/FIFO 的合法串行说成可并行。
 */
export function projectOrchestrationAdvice(core: AnalysisCore): WorkflowOrchestrationAdvice[] {
  const { events, root } = core.trace;
  const asks = new Map(core.sites.asks.map((site) => [site.id, site]));
  const issues = new Map<string, IssueEvent[]>();
  for (const event of events) {
    if (event.at !== "issue") continue;
    const list = issues.get(event.step) ?? [];
    list.push(event);
    issues.set(event.step, list);
  }
  const straight = (regions: readonly string[]): boolean =>
    regions.length === 1 && regions[0] === root;
  const actorOf = (id: string): string | undefined => {
    if (asks.get(id)?.optional) return undefined;
    const actor = core.facts.askActor.get(id);
    const siteIssues = issues.get(id);
    if (actor?.length !== 1 || actor[0]?.exact !== true || siteIssues?.length !== 1)
      return undefined;
    if (!straight(siteIssues[0]!.regions)) return undefined;
    return actor[0].site;
  };
  const frontier = (start: number): CoreAskSite[] => {
    const out: CoreAskSite[] = [];
    for (let i = start; i < events.length; i += 1) {
      const event = events[i]!;
      if (!straight(event.regions)) break;
      if (event.at === "mark" || event.at === "actor") continue;
      if (event.at !== "issue") break;
      const ask = asks.get(event.step);
      // 工作区操作或无法精确定位的接收者是边界，不跨过它推断可提前执行。
      if (ask === undefined || actorOf(ask.id) === undefined) break;
      out.push(ask);
    }
    return out;
  };
  const advice: WorkflowOrchestrationAdvice[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const wait = events[index]!;
    // 已见 return/throw（含条件臂）后的走查残余不保证可达；提示不另建一套可达性分析。
    if (wait.at === "jump") break;
    if (wait.at !== "settle" || wait.loc === undefined || wait.maybe || !straight(wait.regions))
      continue;
    if ((wait.joins?.length ?? 0) > 0 || wait.steps.length === 0) continue;
    const waiting = wait.steps.flatMap((id) => {
      const ask = asks.get(id);
      return ask !== undefined && actorOf(id) !== undefined ? [ask] : [];
    });
    if (waiting.length !== wait.steps.length) continue;
    const waitingActors = new Set(waiting.map((ask) => actorOf(ask.id)));
    const later = frontier(index + 1).filter((ask) => !waitingActors.has(actorOf(ask.id)));
    if (later.length === 0) continue;

    if (wait.join !== undefined) {
      const delayed = later.filter((ask) => consumesJoinSubset(core, wait, ask.id));
      if (
        waiting.length < MIN_BRANCHES ||
        waitingActors.size !== waiting.length ||
        delayed.length === 0
      )
        continue;
      advice.push({
        code: "join-before-per-item-work",
        ...wait.loc,
        waitingOn: waiting.map((ask) => ask.loc),
        delayed: delayed.map((ask) => ask.loc),
        message:
          "This full join waits for all listed branches before the later ask is issued; its known input uses only some branches. Check whether per-branch work can start after its own result. " +
          DEPENDENCY_CAUTION,
      });
      continue;
    }

    if (waiting.length !== 1 || wait.ask !== waiting[0]?.id) continue;
    // 只提示完全没有已知输入交付的前沿；已有输入/控制依赖不尝试做消除或传递闭包。
    const delayed = later.filter((ask) => (core.facts.askData.get(ask.id)?.length ?? 0) === 0);
    if (new Set(delayed.map((ask) => actorOf(ask.id))).size < MIN_BRANCHES) continue;
    advice.push({
      code: "await-before-later-asks",
      ...wait.loc,
      waitingOn: waiting.map((ask) => ask.loc),
      delayed: delayed.map((ask) => ask.loc),
      message:
        "This await controls when the later actor calls are issued: they wait for the listed result. Check whether independent investigations can start before this await. " +
        DEPENDENCY_CAUTION,
    });
  }
  return advice;
}

/** Only exact, indexed tuple ports; no whole-join, alias or fan-out inference. */
function consumesJoinSubset(core: AnalysisCore, wait: SettleEvent, ask: string): boolean {
  if (wait.join === undefined) return false;
  const inputs = core.facts.joinIn.get(wait.join) ?? [];
  if (
    inputs.length < MIN_BRANCHES ||
    inputs.some((input) => !input.exact || input.port === undefined)
  )
    return false;
  if (inputs.some((input) => !wait.steps.includes(input.site))) return false;
  const ports = new Map(inputs.map((input) => [input.port, input.site]));
  if (ports.size !== inputs.length) return false;
  const reads = core.facts.askData.get(ask) ?? [];
  const selected = reads.filter((read) => read.site === wait.join);
  if (selected.length === 0 || selected.some((read) => !read.exact || read.port === undefined))
    return false;
  const used = new Set(selected.map((read) => ports.get(read.port)));
  if (used.has(undefined) || used.size === 0 || used.size >= ports.size) return false;
  // taint 同时携带原始 ask 与 join port；两者必须吻合，模糊/额外来源不报优化结论。
  return reads.every((read) => read.exact && (read.site === wait.join || used.has(read.site)));
}
