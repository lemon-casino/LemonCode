import { RoutingOrderedSet } from "./ordered-set.js";
import { RoutingDeadlineIndex } from "./deadline-index.js";
import type { RoutingRank } from "./ranking.js";
interface Group {
  key: string;
  members: RoutingOrderedSet;
}
/** 等价投影只保留最多 128 个签名；提升后整份释放，不与分散胜者树重复常驻。 */
export class RoutingScoreGroups {
  private readonly groups = new Map<string, Group>();
  private readonly membership = new Map<number, Group>();
  private readonly deadlines = new RoutingDeadlineIndex();
  get size() {
    return this.groups.size;
  }
  get overflow() {
    return this.size > 128;
  }
  get nextAt() {
    return this.deadlines.nextAt;
  }
  takeDue(now: number, limit: number) {
    return this.deadlines.takeDue(now, limit);
  }
  update(rank: RoutingRank, expires: number): void {
    const c = rank.candidate;
    // 共享余额在每次选择时由原账本重读；同组只可省略公共事实，私有事实必须完整参与等价判断。
    const key = JSON.stringify([
      c.quotaGroupId,
      c.windows.filter((w) => !w.shared),
      c.windows.filter((w) => w.shared).map((w) => [w.resourceId, w.instanceId]),
      c.portability,
      c.cacheGroupId,
      c.cacheSwitchCost,
      c.maxInFlight,
      c.health,
      c.unavailable,
      c.availableAt,
      c.statistics,
      c.recentWork,
      c.expiry,
      rank.load,
      rank.concurrency,
      rank.eligibleRound,
    ]);
    const prior = this.membership.get(rank.index);
    if (prior?.key !== key) {
      if (prior) {
        prior.members.delete(rank.index);
        if (!prior.members.size) this.groups.delete(prior.key);
      }
      let group = this.groups.get(key);
      if (!group) {
        group = { key, members: new RoutingOrderedSet() };
        this.groups.set(key, group);
      }
      group.members.add(rank.index);
      this.membership.set(rank.index, group);
    }
    this.deadlines.set(c.id, expires);
  }
  select(ids: readonly string[], cursor: number): { ids: string[]; work: number } {
    const selected = new Set<number>();
    for (const group of this.groups.values()) {
      const first = group.members.first(),
        next = group.members.first(cursor);
      if (first !== undefined) selected.add(first);
      if (next !== undefined) selected.add(next);
    }
    return { ids: [...selected].map((index) => ids[index]!), work: this.groups.size };
  }
}
