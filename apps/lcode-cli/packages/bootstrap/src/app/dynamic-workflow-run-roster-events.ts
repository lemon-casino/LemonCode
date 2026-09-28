// ============================================================
// 情势截面的**事件索引**：一趟扫过 journal 事件，得到一切「多久以前」
// ============================================================
// 阶段表、子代理花名册、健康三组读面
// 要的时间只有一个来源——`StoredEvent.timeCreated`，即事件落 journal 的时刻。节点行
// （`NodeRecord`）没有任何时间列，所以「这次 ask 什么时候开始的」「它上次动是什么时候」
// 只能从事件轨上取。
//
// 本模块是那趟扫描，且只是那趟扫描：纯函数、无 I/O、不认识端口类型。三个消费者
// （-roster-phases / -roster-subagents / -roster）共用它的产物，于是一次 getRunDetail
// 只读一遍事件——这条读面在 run 越长时越贵，读两遍就是白付一倍。

import type { StoredEvent } from "@lcode/dynamic-workflow";

/**
 * 算「还在动吗」时**算数**的事件类型：脚本自己往前走了，或者某个 ask 往前走了。
 *
 * `phase-entered` 与 `log` 在其中，因为它们正是**脚本**在动的证据：两次 ask 之间跑一串
 * world read 的脚本一条 ask 事件都不发，把它们排除掉，那段时间会被误报成停滞。
 *
 * `node-waiting` 刻意**不**在其中：等槽位、等退避正是停滞本身，把它算成进度，
 * `stalledSince` 就永远不会在场——而那恰恰是停滞最典型的形态。`concurrency-changed` 与
 * `run-stalled` 同理不算：它们是**关于不动的观察**，不是动。
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-settled",
  "node-progress",
  "phase-entered",
  "log",
  "report",
  "artifact-published",
  "usage-updated",
]);

/**
 * 节点**生命周期**事件（相位迁移）。`node-progress` 不在其中——一个轮次解析完不是生命周期
 * 跃迁，与 reducer 侧那条纪律逐字相同；子代理的 `waiting` 判据因此不会被进度事件打断。
 */
const NODE_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-waiting",
  "node-repairing",
  "node-nudged",
  "node-settled",
]);

/** 实例键：`siteId@ordinal`，与引擎的 `refToString` 同形。 */
export function instanceKey(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

/** 当前 ask 在等什么（最后一条 `node-waiting` 的观察 + 进入这次等待的时刻）。 */
export interface RosterWaitTrace {
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  since?: number;
}

/** 一个节点实例在事件轨上留下的痕迹。 */
export interface RosterNodeTrace {
  /** 本世最后一次 `node-dispatched` 的时刻（`node-queued` 会清掉：重新排队是新的一世）。 */
  dispatchedAt?: number;
  /** 最后一条生命周期事件的 type；子代理的 `waiting` 判据只看它是不是 `node-waiting`。 */
  lastLifecycleType?: string;
  /** 仅当此刻正处在 waiting 时在场（任何别的生命周期事件都会清掉它）。 */
  wait?: RosterWaitTrace;
  /** 最后一条**带 lastTool** 的 `node-progress` 的时刻。 */
  lastToolAt?: number;
  /** 该实例最后一条进度类事件的时刻。 */
  lastActivityAt?: number;
}

/** 一个阶段**最近一次**进入与离开的时刻。 */
export interface RosterPhaseTrace {
  enteredAt?: number;
  exitedAt?: number;
}

/** 一次节点结算（按事件顺序），健康面的连败与缓存命中都从这串算。 */
export interface RosterSettlement {
  key: string;
  outcome: string;
  cached: boolean;
}

/** 一趟扫描的全部产物。 */
export interface RosterEventIndex {
  nodes: ReadonlyMap<string, RosterNodeTrace>;
  phases: ReadonlyMap<string, RosterPhaseTrace>;
  settlements: readonly RosterSettlement[];
  /** 全 run 最后一条进度类事件的时刻。 */
  lastProgressAt?: number;
  /** 最后一条 `run-stalled` 的时刻，且其后没有任何进度类事件；否则缺席。 */
  stalledSince?: number;
  /** 最后一条 `concurrency-changed` 的原因与时刻（数值上界由 reducer 那一侧给）。 */
  concurrencyReason?: string;
  concurrencySince?: number;
}

/**
 * 扫一遍事件，得到情势截面要的全部时刻。
 *
 * `now` 是本次读的时刻，只做**上钳**：journal 可以被带到另一台机器上读，而一个比「现在」还晚
 * 的时刻会被渲染成负的年龄——那读起来像工具坏了，而不像时钟偏了。缺时间戳的事件（老的内存
 * journal 替身）一律让对应字段缺席，绝不用 `now` 兜底：那会把一周前的整段历史标成「刚刚」。
 */
export function indexRosterEvents(events: readonly StoredEvent[], now: number): RosterEventIndex {
  const nodes = new Map<string, RosterNodeTrace>();
  const phases = new Map<string, RosterPhaseTrace>();
  const settlements: RosterSettlement[] = [];
  let lastProgressAt: number | undefined;
  let stalledAt: number | undefined;
  let stalledPending = false;
  let concurrencyReason: string | undefined;
  let concurrencySince: number | undefined;
  let lastPhaseName: string | undefined;

  for (const stored of events) {
    const { event } = stored;
    const at = timeOf(stored, now);

    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      lastProgressAt = laterOf(lastProgressAt, at);
      // 停滞观察之后只要有任何一条进度，停滞就已经结束了——哪怕这条进度没有时间戳：
      // 「它又动过了」与「它动在什么时候」是两个问题，前者不依赖时钟。
      stalledPending = false;
    }

    if (event.type === "run-stalled") {
      stalledAt = at;
      stalledPending = true;
      continue;
    }
    if (event.type === "concurrency-changed") {
      concurrencyReason = event.reason;
      concurrencySince = at;
      continue;
    }
    if (event.type === "phase-entered") {
      lastPhaseName = trackPhase(phases, event.name, lastPhaseName, at);
      continue;
    }
    if (!("instance" in event)) continue;

    const key = instanceKey(event.instance.siteId, event.instance.ordinal);
    const trace = nodes.get(key) ?? {};
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      trace.lastActivityAt = laterOf(trace.lastActivityAt, at);
    }
    if (NODE_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      trackLifecycle(trace, event.type, at);
    }
    if (event.type === "node-waiting") {
      // 已经在等就保留**进入那一刻**：退避阶梯会连发好几条 node-waiting，而读者问的是
      // 「它卡了多久」，不是「最后一条观察是什么时候发的」。原因与重试间隔则取最新的一条。
      const since = trace.wait?.since ?? at;
      trace.wait = {
        cause: event.cause,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
        ...(since === undefined ? {} : { since }),
      };
    }
    if (event.type === "node-progress" && event.lastTool !== undefined && at !== undefined) {
      trace.lastToolAt = at;
    }
    if (event.type === "node-settled") {
      settlements.push({ key, outcome: event.outcome, cached: event.cached === true });
    }
    nodes.set(key, trace);
  }

  return {
    nodes,
    phases,
    settlements,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(stalledPending && stalledAt !== undefined ? { stalledSince: stalledAt } : {}),
    ...(concurrencyReason === undefined ? {} : { concurrencyReason }),
    ...(concurrencySince === undefined ? {} : { concurrencySince }),
  };
}

/**
 * 记一次 `phase-entered`：它既开启自己这一段，也结束上一个**异名**阶段。
 * 同名再入（回边）只把进入时刻前移，不算离开自己。返回新的「最后进入的阶段名」。
 */
function trackPhase(
  phases: Map<string, RosterPhaseTrace>,
  name: string,
  lastPhaseName: string | undefined,
  at: number | undefined,
): string {
  if (lastPhaseName !== undefined && lastPhaseName !== name && at !== undefined) {
    const previous = phases.get(lastPhaseName);
    if (previous !== undefined) previous.exitedAt = at;
  }
  // 取最近一次进入而不是第一次：被回边绕了三圈的阶段，要问的是「这一圈进来多久了」。
  // 重进即清掉上一圈的离开时刻——它此刻又是开着的。
  phases.set(name, at === undefined ? {} : { enteredAt: at });
  return name;
}

/** 记一条生命周期事件：重新排队清掉上一世的派发时刻，任何非 waiting 事件清掉等待。 */
function trackLifecycle(trace: RosterNodeTrace, type: string, at: number | undefined): void {
  trace.lastLifecycleType = type;
  if (type !== "node-waiting") trace.wait = undefined;
  if (type === "node-queued") trace.dispatchedAt = undefined;
  if (type === "node-dispatched" && at !== undefined) trace.dispatchedAt = at;
}

/**
 * 事件的落库时刻。缺席、非有限值与非正值一律读作「没有时钟」——`0` 是 1970 年，
 * 它只可能是某处漏填，而不是一个真的时刻。
 */
function timeOf(stored: StoredEvent, now: number): number | undefined {
  const time = stored.timeCreated;
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return undefined;
  return Math.min(time, now);
}

/** 两个可缺席时刻里更晚的那个。 */
export function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
