// ============================================================
// Dynamic Workflow Run 的**情势截面**：阶段 / 子代理 / 健康
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出，理由与 dwf-journal-introspection.ts 同一条：那份契约
// 已到 oxlint 的 max-lines 上限。公开面不变——主端口文件原地再导出这里的每一个名字，
// `@lcode/contracts` 的导入路径逐字不动。
//
// 三组字段挂在 `DynamicWorkflowRunDetail` 上，由读面在 `getRunDetail` 里读时派生；
// 契约与不变式见下方各类型的注释。

import type {
  WorkflowNodeActivity,
  WorkflowNodeQueue,
  WorkflowRunNode,
} from "@lcode/shared/lcode-protocol-v4";

// 一条贯穿三组的纪律：**时间只有一个来源**，即 `dwf_event.time_created`（事件落 journal 的
// 时刻）。读者现取 `Date.now()` 兜底是错的——那会把一次冷读里一周前的整段历史全标成「刚刚」，
// 而这三组字段存在的全部理由就是让「多久以前」可信。没有这个列的老 journal 一律让时间字段
// **缺席**，不给 0、不给 NaN。

/**
 * 一个阶段在情势截面里的处境。
 *
 * - `ahead`：脚本声明了它，控制流还没到——**唯一** `rounds: 0` 的状态；
 * - `current`：run 还活着，且它是最后进入的那个阶段；
 * - `unfinished`：run 已终态，而这个阶段里还有没结算的 ask（进程死在它下面）；
 * - `done`：其余。
 */
export type DynamicWorkflowRunPhaseState = "done" | "current" | "ahead" | "unfinished";

/** 情势截面里的一个阶段（`phase("…")` 标记）。 */
export interface DynamicWorkflowRunPhaseView {
  /** 作者原词，与 `run-launched.phaseNames` / `phase-entered.name` 同一个词表。 */
  name: string;
  state: DynamicWorkflowRunPhaseState;
  /** 被进入过几次（同名再入即 +1）。`ahead` 恒为 0，其余恒 ≥ 1。 */
  rounds: number;
  /** 出生在这个阶段的节点里已结算 / 未结算的条数。 */
  nodesSettled: number;
  nodesRunning: number;
  /**
   * **最近一次**进入的时刻，以及那一次的离开时刻（下一个异名 `phase-entered` 的时刻）。
   * 取最近一次而不是第一次：一个被回边绕了三圈的阶段，读者要问的是「这一圈进来多久了」。
   * 当前阶段没有离开时刻；事件缺时间戳时两者一并缺席。
   */
  enteredAt?: number;
  exitedAt?: number;
}

/**
 * 一个子代理此刻的处境。**读的顺序就是写的顺序**，前一条命中即定案：
 *
 * run 未终态：`parked`（问题待答）→ `waiting`（已入队、准备派发、暂停或等待供应商）→
 * `executing`（节点明确 executing/repairing/nudged）→ `failed`（最后一次 ask 失败）→ `idle`。
 * journal running 仅代表未结算，不代表已派发；详细原因由 currentAsk.phase/queue 与 wait 说明。
 *
 * run 已终态：三个活着的词全部退场——`unfinished`（还有 ask 行标着 running，即进程死在它
 * 下面）→ `failed` → `done`。
 */
export type DynamicWorkflowRunSubagentState =
  | "idle"
  | "executing"
  | "waiting"
  | "parked"
  | "done"
  | "failed"
  | "unfinished";

/**
 * 一次 ask 里最近被观察到的工具调用。`target` 是给人看的**线索**（文件路径、命令头），
 * 不是入参本身——这条链路从引擎到这里每一段都按同一条界切，入参全文永不进来。
 */
export interface DynamicWorkflowRunSubagentLastTool {
  name: string;
  target?: string;
  /** 观察到它的那条 `node-progress` 的落库时刻；事件无时间戳时缺席。 */
  at?: number;
}

/** 子代理当前未结算的队首 ask；phase 区分排队、准备、执行、等待与暂停。 */
export interface DynamicWorkflowRunSubagentAsk {
  siteId: string;
  ordinal: number;
  /** 这是该子代理的第几次 ask（journal 的 `actorSeq`）；不落这一列的老行缺席。 */
  actorSeq?: number;
  /**
   * 作者写给这次 ask 的指令的头 240 字。读面据它回答「这个子代理被派去干什么」——相位只
   * 说得出「在跑」。不带 `instructionsHead` 的老 journal 上缺席，**不去读指令全文补**。
   */
  instructionsHead?: string;
  /** 这次 ask 的 `node-dispatched` 时刻；事件无时间戳时缺席。 */
  startedAt?: number;
  /**
   * 已解析到第几轮、累计调了几次工具（随 `node-progress` 到达）。
   * 没有 `node-progress` 的老 journal 上一律缺席——缺席读作「不知道」，`0` 读作
   * 「一个工具都没调过」，这是两个不同的事实。
   */
  turn?: number;
  toolCalls?: number;
  lastTool?: DynamicWorkflowRunSubagentLastTool;
  activity?: WorkflowNodeActivity;
  phase?: WorkflowRunNode["phase"];
  queue?: WorkflowNodeQueue;
}

/** 当前 ask 正在等什么（最后一条 `node-waiting` 的观察）。 */
export interface DynamicWorkflowRunSubagentWait {
  /** `slot` = 在等进程级准入闸门；`backoff` = runner 在退避重试。 */
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  attempt?: number;
  nextRetryAt?: number;
  /**
   * **进入本次等待**的时刻（即最近一条非 waiting 生命周期事件之后的第一条
   * `node-waiting`），不是最后一条的时刻：退避阶梯会连发好几条，而读者问的是「它卡了多久」。
   * 事件无时间戳时缺席。
   */
  since?: number;
}

/** 情势截面里的一个子代理（= 一个 actor 实例）。 */
export interface DynamicWorkflowRunSubagentView {
  siteId: string;
  ordinal: number;
  /** `agent("poet")` 的有效名；匿名 actor 缺席，这里不合成兜底标签（同 pendingQuestions）。 */
  name?: string;
  state: DynamicWorkflowRunSubagentState;
  /** 它当前（或最后）那次 ask 出生在哪个阶段；都读不出时退到它自己的出生阶段。 */
  phaseName?: string;
  currentAsk?: DynamicWorkflowRunSubagentAsk;
  wait?: DynamicWorkflowRunSubagentWait;
  /**
   * 它停在哪个问题上（`pendingQuestions[].qid`）。**只有确实查得到停驻表时才可能在场**：
   * `health.pendingQuestionsKnown` 为假的那次读根本不知道有没有人在等，见那个字段。
   */
  parkedOn?: string;
  /** 它已结算 / 其中失败的 ask 条数，以及这些 ask 的 token 之和（节点行的 `stats`）。 */
  stepsSettled: number;
  stepsFailed: number;
  tokens: number;
  /** 最后一次被观察到在动的时刻（它名下任一节点的最后一条进度类事件）。 */
  lastProgressAt?: number;
  /** 该 actor 已观察到的最近一次非缓存成功交付，与当前 ask 的活动独立。 */
  lastDeliveredAt?: number;
}

/**
 * run 级并发现状：它此刻被压到了多少，本该是多少，以及为什么、从什么时候起。
 *
 * **整个对象只在 `effective < cap` 时在场**（与详情面的 `maxConcurrency` 同一条缺席规则）：
 * 一个跑满自己那条界的 run 没有可说的，而这里在场就等于「它正被限着」。
 */
export interface DynamicWorkflowRunConcurrencyHealth {
  /** 治理器此刻实际放行的数 = min(共享闸门, {@link cap})。 */
  effective: number;
  /**
   * **这个 run 自己的**上界：用户给它定过就是那个数，没定过才是本机天花板。
   *
   * 刻意不报天花板：一个以 `max_concurrency: 3` 起的 run 在六核机器上会永远显示成「3/6」，
   * 读起来像被限流，而它正跑在用户亲手定的界上——那条界不是故障，是设定。
   */
  cap: number;
  /** 最后一条 `concurrency-changed` 的原因（`rate_limited` / `recovered` …）。 */
  reason?: string;
  /** 那条事件的落库时刻；无时间戳时缺席。 */
  since?: number;
}

/** run 整体还在不在动。 */
export interface DynamicWorkflowRunHealth {
  /** 全 run 最后一条进度类事件的时刻。 */
  lastProgressAt?: number;
  /**
   * 最后一条 `run-stalled` 的时刻，且其后**没有**任何进度类事件。
   * 「等槽位」不算进度——那段等待正是停滞本身，把它算进去就永远看不到停滞。
   */
  stalledSince?: number;
  concurrency?: DynamicWorkflowRunConcurrencyHealth;
  /** 按结算顺序**结尾处连续**失败的 ask 数：3 次连挂与散落 3 次是两个不同的处境。 */
  consecutiveFailures: number;
  /** 命中完结缓存（`node-settled { cached: true }`）的结算数。 */
  cachedSteps: number;
  /** **仅终态 run**：还标着 `running` 的节点行数，也就是进程死在它们下面的那些。为 0 时缺席。 */
  leftoverRunning?: number;
  /**
   * 这次读**能不能**回答「有没有问题在等答案」。
   *
   * 停驻的问题只活在提问那个进程的内存里（见 {@link DynamicWorkflowRunDetail.pendingQuestions}），
   * 所以读另一个进程名下在飞的 run 时，「没有待答问题」与「不知道」长得一模一样——而这两者
   * 对模型是两个完全不同的下一步。为真的条件是：本会话持有这个 run 的注册表条目，或 run 已
   * 终态（终态 run 按定义没有在听的人）。为假时 `pendingQuestions` 整字段缺席，且没有任何
   * 子代理会被报成 `parked`。
   */
  pendingQuestionsKnown: boolean;
}
