// ============================================================
// 情势截面的**子代理花名册**：每个子代理此刻在干什么
// ============================================================
// 一个子代理 = 一个 actor 实例，它名下的
// ask 按 `actorSeq` 依次跑，所以「它此刻在干什么」= 它那条 ask 链走到哪了。
//
// 三份取数各司其职，不互相冒充：
//   - **actor 行 / 节点行**（journal）：谁存在、每次 ask 成没成、花了多少 token。行是持久事实，
//     没有上界，也不会被投影的淘汰规则吃掉。
//   - **归约状态**：这次 ask 的任务摘要与进度读数（`instructionsHead` / `turn` / `toolCalls` /
//     `lastTool`）、以及节点的阶段坐标——它们只活在事件上，行上没有这些列。
//   - **事件索引**：一切时刻。见 -roster-events.ts 的文件头。

import type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunSubagentAsk,
  DynamicWorkflowRunSubagentState,
  DynamicWorkflowRunSubagentView,
} from "@lcode/contracts";
import type { ActorRecord, NodeRecord } from "@lcode/dynamic-workflow";
import type { WorkflowRunNode, WorkflowRunState } from "@lcode/shared/lcode-protocol-v4";
import {
  instanceKey,
  laterOf,
  type RosterEventIndex,
  type RosterNodeTrace,
} from "./dynamic-workflow-run-roster-events.js";

/** 节点行的「还没结算」状态，也是 `unfinished` / `leftoverRunning` 的判据。 */
export const NODE_ROW_RUNNING = "running";

/** 一个子代理名下的 ask 行，按 `actorSeq` 升序（缺这一列的老行排在最前，顺序稳定）。 */
function asksOf(
  nodes: readonly NodeRecord[],
  actor: Pick<ActorRecord, "siteId" | "ordinal">,
): NodeRecord[] {
  return nodes
    .filter((node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal)
    .sort((left, right) => (left.actorSeq ?? 0) - (right.actorSeq ?? 0));
}

/**
 * 花名册，按 actor 行的顺序（= 铸造顺序）。**恒返回数组**，一个 actor 都没有就是空数组：
 * 「这个 run 有几个子代理」永远是个有答案的问题，而 0 就是那个答案。
 *
 * `pendingQuestions` 为 `undefined` 即「这次读查不到停驻表」（run 在别的进程名下）：那时
 * **没有任何子代理会被报成 `parked`**，因为此刻分不出「没人在等」与「不知道」。
 */
export function buildSubagentViews(input: {
  actors: readonly ActorRecord[];
  nodes: readonly NodeRecord[];
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
}): DynamicWorkflowRunSubagentView[] {
  const { actors, nodes, run, index, terminal, pendingQuestions } = input;
  const reduced = new Map<string, WorkflowRunNode>();
  for (const node of run?.nodes ?? []) reduced.set(instanceKey(node.siteId, node.ordinal), node);

  return actors.map((actor) => {
    const asks = asksOf(nodes, actor);
    const settled = asks.filter((ask) => ask.status !== NODE_ROW_RUNNING);
    // 同一个子代理的 ask 是串行的，所以「在跑的那一条」至多一条；真有多条时取 actorSeq
    // 最大的那条——它是最近被派下去的。
    const runningAsk = asks.filter((ask) => ask.status === NODE_ROW_RUNNING).at(-1);
    const trace =
      runningAsk === undefined
        ? undefined
        : index.nodes.get(instanceKey(runningAsk.siteId, runningAsk.ordinal));
    const parkedOn = pendingQuestions?.find(
      (question) => question.actor === instanceKey(actor.siteId, actor.ordinal),
    )?.qid;
    const lastAskFailed = settled.at(-1)?.status === "failed";

    return {
      siteId: actor.siteId,
      ordinal: actor.ordinal,
      ...(actor.name === undefined ? {} : { name: actor.name }),
      state: subagentStateOf({
        terminal,
        running: runningAsk !== undefined,
        waiting: trace?.lastLifecycleType === "node-waiting",
        parked: parkedOn !== undefined,
        lastAskFailed,
      }),
      ...phaseNameField({ actor, runningAsk, settled, reduced, run }),
      ...(runningAsk === undefined ? {} : { currentAsk: currentAskOf(runningAsk, reduced, trace) }),
      ...(trace?.wait === undefined ? {} : { wait: trace.wait }),
      ...(parkedOn === undefined ? {} : { parkedOn }),
      stepsSettled: settled.length,
      stepsFailed: settled.filter((ask) => ask.status === "failed").length,
      // 只累计已结算 ask 的 token：在飞的那条还没有账（`stats` 由 driver 在结算时回填）。
      tokens: settled.reduce((total, ask) => total + (ask.stats?.tokens ?? 0), 0),
      ...lastProgressField(asks, index),
    };
  });
}

/**
 * 子代理的处境。**判定顺序就是这段代码的顺序**，前一条命中即定案——顺序本身是契约的一部分：
 * 一个停驻等答案的子代理同时也「有 ask 在跑」，报 `executing` 就会把它要人命的那件事藏起来。
 */
function subagentStateOf(input: {
  terminal: boolean;
  running: boolean;
  waiting: boolean;
  parked: boolean;
  lastAskFailed: boolean;
}): DynamicWorkflowRunSubagentState {
  const { terminal, running, waiting, parked, lastAskFailed } = input;
  if (terminal) {
    // 终态 run 上三个活着的词全部退场：还标着 running 的行只说明进程死在了它下面。
    if (running) return "unfinished";
    return lastAskFailed ? "failed" : "done";
  }
  if (parked) return "parked";
  if (running) return waiting ? "waiting" : "executing";
  return lastAskFailed ? "failed" : "idle";
}

/** 当前 ask 的截面：身份来自行，任务与进度来自归约状态，时刻来自事件索引。 */
function currentAskOf(
  ask: NodeRecord,
  reduced: ReadonlyMap<string, WorkflowRunNode>,
  trace: RosterNodeTrace | undefined,
): DynamicWorkflowRunSubagentAsk {
  const node = reduced.get(instanceKey(ask.siteId, ask.ordinal));
  const lastTool = node?.lastTool;
  return {
    siteId: ask.siteId,
    ordinal: ask.ordinal,
    ...(ask.actorSeq === undefined ? {} : { actorSeq: ask.actorSeq }),
    ...(node?.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    ...(trace?.dispatchedAt === undefined ? {} : { startedAt: trace.dispatchedAt }),
    ...(node?.turn === undefined ? {} : { turn: node.turn }),
    ...(node?.toolCalls === undefined ? {} : { toolCalls: node.toolCalls }),
    ...(lastTool === undefined
      ? {}
      : {
          lastTool: {
            name: lastTool.name,
            ...(lastTool.target === undefined ? {} : { target: lastTool.target }),
            ...(trace?.lastToolAt === undefined ? {} : { at: trace.lastToolAt }),
          },
        }),
  };
}

/**
 * 它当前（或最后）那次 ask 出生在哪个阶段；两条 ask 都读不出时退到 actor 自己的出生阶段。
 * 阶段坐标只在归约状态上，所以这里查的是归约节点，不是行。
 */
function phaseNameField(input: {
  actor: Pick<ActorRecord, "siteId" | "ordinal">;
  runningAsk: NodeRecord | undefined;
  settled: readonly NodeRecord[];
  reduced: ReadonlyMap<string, WorkflowRunNode>;
  run: WorkflowRunState | undefined;
}): Pick<DynamicWorkflowRunSubagentView, "phaseName"> {
  const { actor, runningAsk, settled, reduced, run } = input;
  const candidates = [runningAsk, settled.at(-1)];
  for (const ask of candidates) {
    if (ask === undefined) continue;
    const phaseName = reduced.get(instanceKey(ask.siteId, ask.ordinal))?.phaseName;
    if (phaseName !== undefined) return { phaseName };
  }
  const born = run?.actors.find(
    (entry) => entry.siteId === actor.siteId && entry.ordinal === actor.ordinal,
  )?.phaseName;
  return born === undefined ? {} : { phaseName: born };
}

/** 它最后一次被观察到在动的时刻：名下任一 ask 的最后一条进度类事件。 */
function lastProgressField(
  asks: readonly NodeRecord[],
  index: RosterEventIndex,
): Pick<DynamicWorkflowRunSubagentView, "lastProgressAt"> {
  let latest: number | undefined;
  for (const ask of asks) {
    latest = laterOf(latest, index.nodes.get(instanceKey(ask.siteId, ask.ordinal))?.lastActivityAt);
  }
  return latest === undefined ? {} : { lastProgressAt: latest };
}
