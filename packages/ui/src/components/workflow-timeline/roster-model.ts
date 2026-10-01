import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill } from "./timeline-model.js";

/**
 * 阶段名册：一站的参与者过了阈值，药丸列
 * 换成「钉住的几枚药丸 + 其余」。这里只做纯的划分——谁被钉住、谁是其余、各状态几人——卡、轮尾摘要、
 * 确认窗与侧板四处同一条规则。卡把「其余」折成一行「还有 n 个」（`rosterMore`）；侧板把同一行当门，门后是按状态分组的名单（`rosterRoll`）。
 */

/** 参与者 ≤ 这么多枚时仍是药丸列（六枚 = 222 px，已经比名册高）。 */
export const ROSTER_THRESHOLD = 6;
/** 卡上钉住的药丸数：五枚 + 「还有 n 个」一行 = 六枚药丸的高度。 */
export const ROSTER_PINS_CARD = 5;
/** 侧板钉住的药丸数（拉满一列，有地方多说几个名字）。 */
export const ROSTER_PINS_PANE = 5;
/** 还在跑的不多于这么多时才具名（fan-out 早期它们只是琥珀格）。 */
export const STRAGGLER_LIMIT = 3;
/** 「还有 n 个」那一行上叠着的脸数。 */
export const ROSTER_DECK = 3;

export type RosterCounts = Record<StepRunStatus, number>;

export interface StationRoster {
  /** 钉住的药丸：failed → asking → stragglers → 按参与者序补位，槽永不空。 */
  pinned: TimelinePill[];
  /** 其余参与者（没被钉住的）：按参与者序。 */
  rest: TimelinePill[];
  /** 全部参与者（钉住的也算）按状态计数；静态药丸计作 pending。 */
  counts: RosterCounts;
  total: number;
}

/** 静态（无 run）与 pending 逐像素相同，计数上也归一类。 */
export function pillStatusOf(pill: Pick<TimelinePill, "status">): StepRunStatus {
  return pill.status ?? "pending";
}

/** 实例键（`siteId@ordinal`）：待答问题按它挂到提问者；合成车道没有。 */
export function pillInstanceKey(pill: Pick<TimelinePill, "instance">): string | undefined {
  return pill.instance === undefined
    ? undefined
    : `${pill.instance.siteId}@${pill.instance.ordinal}`;
}

export function rosterCounts(pills: readonly TimelinePill[]): RosterCounts {
  const counts: RosterCounts = { cancelled: 0, done: 0, failed: 0, pending: 0, running: 0 };
  for (const pill of pills) counts[pillStatusOf(pill)] += 1;
  return counts;
}

/** 注意力序：「还有 n 个」那一叠脸先露最要紧的；名单的组也按它排。 */
export const ATTENTION_ORDER: readonly StepRunStatus[] = [
  "failed",
  "running",
  "cancelled",
  "pending",
  "done",
];
const ATTENTION_RANK: Record<StepRunStatus, number> = {
  failed: 0,
  running: 1,
  cancelled: 2,
  pending: 3,
  done: 4,
};

/** 稳定的注意力排序：同一档内保持参与者序。 */
function byAttention(pills: readonly TimelinePill[]): TimelinePill[] {
  return pills
    .map((pill, index) => ({ index, pill }))
    .sort(
      (left, right) =>
        ATTENTION_RANK[pillStatusOf(left.pill)] - ATTENTION_RANK[pillStatusOf(right.pill)] ||
        left.index - right.index,
    )
    .map((entry) => entry.pill);
}

export function stationRoster(
  pills: readonly TimelinePill[],
  options: { pins: number },
): StationRoster | undefined {
  if (pills.length <= ROSTER_THRESHOLD) return undefined;
  const counts = rosterCounts(pills);

  const pinned: TimelinePill[] = [];
  const pin = (pill: TimelinePill) => {
    if (pinned.length < options.pins && !pinned.includes(pill)) pinned.push(pill);
  };
  for (const pill of pills) if (pillStatusOf(pill) === "failed") pin(pill);
  for (const pill of pills) if (pill.asking === true) pin(pill);
  if (counts.running <= STRAGGLER_LIMIT) {
    for (const pill of pills) if (pillStatusOf(pill) === "running") pin(pill);
  }
  for (const pill of pills) pin(pill);

  const rest = pills.filter((pill) => !pinned.includes(pill));
  return { counts, pinned, rest, total: pills.length };
}

/** 卡上「还有 n 个」那一行的内容。 */
export interface RosterMore {
  /** 没被钉住的参与者数。 */
  count: number;
  /** 叠着的脸：其余里按注意力序的前几个（failed → running → cancelled → pending → done）。 */
  deck: TimelinePill[];
  /** 藏在这一行后面的 failed 数（钉住的不算）——卡上这一行唯一会说的状态。 */
  failed: number;
}

export function rosterMore(roster: StationRoster, deck: number = ROSTER_DECK): RosterMore {
  const pinnedFailed = roster.pinned.filter((pill) => pillStatusOf(pill) === "failed").length;
  return {
    count: roster.rest.length,
    deck: byAttention(roster.rest).slice(0, deck),
    failed: roster.counts.failed - pinnedFailed,
  };
}

/** 侧板名单里的一组：同一状态的其余参与者，参与者序。 */
export interface RollGroup {
  status: StepRunStatus;
  pills: TimelinePill[];
}

/** 门后的名单：其余按状态分组、组序即注意力序、空组缺席。 */
export function rosterRoll(roster: StationRoster): RollGroup[] {
  return ATTENTION_ORDER.map((status) => ({
    pills: roster.rest.filter((pill) => pillStatusOf(pill) === status),
    status,
  })).filter((group) => group.pills.length > 0);
}
