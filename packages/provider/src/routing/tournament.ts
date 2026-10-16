import type { RoutingRequest } from "@lcode/shared/provider-routing";
import { RoutingDeadlineIndex } from "./deadline-index.js";
import {
  compareRoutingScore,
  routingScore,
  routingReady,
  routingQuotaKnown,
  routingExpiryUsable,
  type RoutingRank,
} from "./ranking.js";

const STRATEGIES = [
  "primary-backup",
  "headroom-balance",
  "reliable-first",
  "reliable-first",
  "expiry-first",
] as const;
/** 派生胜者树：存位置和排序证据，不拥有余额/份额。所有评分复用 planner 的函数。 */
export class RoutingTournament {
  private readonly base: number;
  private readonly winners: Int32Array[];
  private readonly evidence: Int32Array[];
  private readonly round: Float64Array[];
  private readonly unknown: Uint8Array[];
  private readonly scores: number[][][];
  private readonly deadlines = new RoutingDeadlineIndex();
  private work = 0;
  constructor(
    private readonly entries: RoutingRank[],
    private readonly request: RoutingRequest,
  ) {
    this.base = 2 ** Math.ceil(Math.log2(Math.max(1, entries.length)));
    const integers = () => new Int32Array(this.base * 2).fill(-1);
    this.winners = STRATEGIES.map(integers);
    // signal, quota, missing-price, price A/B, expiry-unit A/B, usable-expiry
    this.evidence = Array.from({ length: 8 }, integers);
    this.round = Array.from({ length: 2 }, () => new Float64Array(this.base * 2).fill(Infinity));
    this.unknown = Array.from({ length: 2 }, () => new Uint8Array(this.base * 2));
    this.scores = Array.from({ length: STRATEGIES.length }, () => []);
    for (const entry of entries) this.leaf(entry);
    for (let node = this.base - 1; node; node--) this.merge(node);
    this.work = 0;
  }
  private leaf(entry: RoutingRank): void {
    this.entries[entry.index] = entry;
    this.deadlines.set(entry.candidate.id, entry.expires);
    const node = this.base + entry.index;
    const ready = routingReady(entry.candidate),
      known = routingQuotaKnown(entry.candidate, entry.now);
    for (let variant = 0; variant < STRATEGIES.length; variant++) {
      this.winners[variant]![node] = entry.eligible ? entry.index : -1;
      this.scores[variant]![entry.index] = routingScore(
        STRATEGIES[variant]!,
        entry.candidate,
        this.request,
        {
          ...entry,
          positive: true,
          ring: entry.index,
          pricesKnown: variant === 3,
        },
      );
    }
    const candidate = entry.candidate;
    const priced =
      ready &&
      candidate.statistics!.marginalCost !== undefined &&
      Boolean(candidate.statistics!.currency);
    const evidence = [
      ready || known || candidate.health === "degraded",
      known,
      !priced,
      priced,
      false,
      Boolean(candidate.expiry),
      false,
      routingExpiryUsable(candidate, entry.now),
    ];
    for (let i = 0; i < evidence.length; i++)
      this.evidence[i]![node] = entry.eligible && evidence[i] ? entry.index : -1;
    for (let tier = 0; tier < 2; tier++)
      this.round[tier]![node] =
        entry.eligible && tier === entry.tier ? entry.eligibleRound : Infinity;
    this.unknown[0]![node] =
      entry.eligible && !known && candidate.health !== "degraded" ? 1 << entry.tier : 0;
    this.unknown[1]![node] =
      entry.eligible && !known && !ready && candidate.health !== "degraded" ? 1 << entry.tier : 0;
  }
  private merge(node: number): void {
    const left = node * 2,
      right = left + 1;
    for (let variant = 0; variant < this.winners.length; variant++) {
      const values = this.winners[variant]!,
        a = values[left]!,
        b = values[right]!;
      this.work++;
      values[node] =
        a < 0
          ? b
          : b < 0
            ? a
            : compareRoutingScore(this.scores[variant]![a]!, this.scores[variant]![b]!) <= 0
              ? a
              : b;
    }
    for (const index of [0, 1, 2, 7])
      this.evidence[index]![node] =
        this.evidence[index]![left]! >= 0
          ? this.evidence[index]![left]!
          : this.evidence[index]![right]!;
    for (const pair of [3, 5]) {
      const choices = [
        this.evidence[pair]![left]!,
        this.evidence[pair + 1]![left]!,
        this.evidence[pair]![right]!,
        this.evidence[pair + 1]![right]!,
      ].filter((index) => index >= 0);
      const first = choices[0] ?? -1;
      const unit = (index: number) =>
        pair === 3
          ? this.entries[index]!.candidate.statistics?.currency
          : this.entries[index]!.candidate.expiry?.comparableUnit;
      this.evidence[pair]![node] = first;
      this.evidence[pair + 1]![node] = choices.find((index) => unit(index) !== unit(first)) ?? -1;
    }
    for (let tier = 0; tier < 2; tier++) {
      this.round[tier]![node] = Math.min(this.round[tier]![left]!, this.round[tier]![right]!);
      this.unknown[tier]![node] = this.unknown[tier]![left]! | this.unknown[tier]![right]!;
    }
  }
  update(entry: RoutingRank): void {
    this.leaf(entry);
    for (let node = (this.base + entry.index) >> 1; node; node >>= 1) this.merge(node);
  }
  takeDue(now: number): string[] {
    return this.deadlines.takeDue(now);
  }
  private first(from: number, matches: (node: number) => boolean): number {
    const visit = (node: number, lo: number, hi: number): number => {
      this.work++;
      if (hi <= from || lo >= this.entries.length || !matches(node)) return -1;
      if (hi - lo === 1) return lo;
      const middle = (lo + hi) >> 1;
      const left = visit(node * 2, lo, middle);
      return left >= 0 ? left : visit(node * 2 + 1, middle, hi);
    };
    const found = visit(1, 0, this.base);
    return found >= 0 || from === 0 ? found : this.first(0, matches);
  }
  select(cursor: number, round: number): { ids: string[]; work: number } {
    const indices = new Set<number>();
    for (const variants of [this.winners, this.evidence])
      for (const values of variants) indices.add(values[1]!);
    const best = this.winners[0]![1]!;
    if (best < 0 && this.entries.length) indices.add(0);
    if (best >= 0) {
      const tier = this.entries[best]!.tier;
      const eligible = Math.max(round, this.round[tier]![1]!);
      indices.add(this.first(cursor, (node) => this.round[tier]![node]! <= eligible));
      for (const unknown of this.unknown)
        indices.add(this.first(cursor, (node) => Boolean(unknown[node]! & (1 << tier))));
    }
    const work = this.work;
    this.work = 0;
    return {
      ids: [...indices]
        .filter((index) => index >= 0)
        .map((index) => this.entries[index]!.candidate.id),
      work,
    };
  }
}
