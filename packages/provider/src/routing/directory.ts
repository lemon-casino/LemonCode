import type { RoutingCandidate, RoutingRequest } from "@lcode/shared/provider-routing";
import { RoutingOrderedSet } from "./ordered-set.js";
import { RoutingDeadlineIndex } from "./deadline-index.js";
import { RoutingTournament } from "./tournament.js";
import type { RoutingRank } from "./ranking.js";
type Classifier = (
  candidate: RoutingCandidate,
  request: RoutingRequest,
) => { key: string; expires: number; rank?: RoutingRank };
interface Profile {
  request: RoutingRequest;
  cohorts: Map<string, RoutingOrderedSet>;
  membership: Map<string, string>;
  deadlines: RoutingDeadlineIndex;
  ranked?: RoutingTournament;
  rankDirty?: boolean;
}
const PROFILE_LIMIT = 8;
const RANK_THRESHOLD = 128;
/** 只索引当前需求下等价的目录位置；余额、份额和绑定仍由 Scheduler 拥有。 */
export class RoutingDirectory {
  readonly order: ReadonlyMap<string, number>;
  readonly ids: readonly string[];
  private readonly profiles = new Map<string, Profile>();
  private builds = 0;
  private scannedKeys = 0;
  private lastInspected = 0;
  private refreshedKeys = 0;
  private rankBuilds = 0;
  private rankWork = 0;
  private invalidatedMembers = 0;
  private readonly groupById = new Map<string, string>();
  private readonly groups = new Map<string, Set<string>>();
  constructor(
    readonly sourceIds: readonly string[],
    readonly read: (id: string) => RoutingCandidate,
    policyOrder?: readonly string[],
  ) {
    const ids = sourceIds;
    const present = new Set(ids),
      leading = (policyOrder ?? []).filter((id) => present.has(id));
    const listed = new Set(leading);
    this.ids = [...leading, ...ids.filter((id) => !listed.has(id))];
    this.order = new Map(this.ids.map((id, index) => [id, index]));
  }
  select(
    request: RoutingRequest,
    cursor: number,
    classify: Classifier,
    now: number,
    binding?: string,
    round = 0,
  ): RoutingCandidate[] {
    const key = JSON.stringify([
      request.tokens,
      request.workUnits,
      request.demands,
      request.modelKey,
    ]);
    let profile = this.profiles.get(key);
    if (profile)
      for (const id of profile.deadlines.takeDue(now)) this.refresh(profile, id, classify);
    if (!profile) {
      profile = {
        request: {
          ...request,
          attemptId: "index",
          scopeKey: "index",
          turnId: undefined,
          signal: undefined,
          tokens: request.tokens ? { ...request.tokens } : undefined,
          demands: request.demands ? { ...request.demands } : undefined,
        },
        cohorts: new Map(),
        membership: new Map(),
        deadlines: new RoutingDeadlineIndex(),
      };
      this.builds++;
      const rankings: RoutingRank[] = [];
      for (const id of this.ids) {
        this.scannedKeys++;
        const rank = this.insert(profile, id, classify);
        if (rank) rankings.push(rank);
      }
      if (profile.cohorts.size > RANK_THRESHOLD && rankings.length === this.ids.length) {
        profile.ranked = new RoutingTournament(rankings, profile.request);
        this.rankBuilds++;
      }
      if (this.profiles.size >= PROFILE_LIMIT)
        this.profiles.delete(this.profiles.keys().next().value!);
    }
    this.profiles.delete(key);
    this.profiles.set(key, profile);
    const result: RoutingCandidate[] = [];
    if (profile.rankDirty) {
      const rankings = this.ids.map((id) => {
        this.scannedKeys++;
        return classify(this.read(id), profile!.request).rank!;
      });
      profile.ranked = new RoutingTournament(rankings, profile.request);
      profile.rankDirty = false;
      this.rankBuilds++;
    }
    if (profile.ranked) {
      for (const id of profile.ranked.takeDue(now)) this.refresh(profile, id, classify);
      const selected = profile.ranked.select(cursor, round);
      this.rankWork = selected.work;
      for (const id of selected.ids) result.push(this.read(id));
    } else
      for (const members of profile.cohorts.values()) {
        const first = members.first(cursor);
        if (first !== undefined) result.push(this.read(this.ids[first]!));
        // 可靠/余量的最后平局使用顺序；份额与探索使用环形后继，两者均保留。
        const ordered = members.first();
        if (ordered !== undefined && ordered !== first) result.push(this.read(this.ids[ordered]!));
      }
    if (binding && this.order.has(binding) && !result.some((candidate) => candidate.id === binding))
      result.push(this.read(binding));
    this.lastInspected = result.length;
    return result;
  }
  private insert(profile: Profile, id: string, classify: Classifier): RoutingRank | undefined {
    const candidate = this.read(id);
    const group =
      candidate.quotaGroupId ??
      (candidate.windows.some((window) => window.shared)
        ? JSON.stringify(
            candidate.windows
              .filter((window) => window.shared)
              .map((window) => [window.resourceId, window.instanceId]),
          )
        : undefined);
    if (group && !this.groupById.has(id)) {
      this.groupById.set(id, group);
      let ids = this.groups.get(group);
      if (!ids) {
        ids = new Set();
        this.groups.set(group, ids);
      }
      ids.add(id);
    }
    const result = classify(candidate, profile.request);
    let members = profile.cohorts.get(result.key);
    if (!members) {
      members = new RoutingOrderedSet();
      profile.cohorts.set(result.key, members);
    }
    members.add(this.order.get(id)!);
    profile.membership.set(id, result.key);
    profile.deadlines.set(id, result.expires);
    if (result.rank) profile.ranked?.update(result.rank);
    return result.rank;
  }
  touch(id: string, classify: Classifier): void {
    if (!this.order.has(id)) return;
    for (const profile of this.profiles.values()) this.refresh(profile, id, classify);
  }
  touchGroupFor(id: string, classify: Classifier): void {
    const group = this.groupById.get(id);
    if (group) this.touchGroup(group, classify, id);
  }
  touchGroup(group: string, classify: Classifier, skipId?: string): void {
    const members = this.groups.get(group);
    if (!members) return;
    for (const profile of this.profiles.values()) {
      if (!profile.ranked || profile.rankDirty) continue;
      this.invalidatedMembers += members.size;
      // 大共享池的共同约束变化会影响全部叶子，下一次显式重建一次，不能静默使用旧胜者。
      if (members.size > RANK_THRESHOLD) profile.rankDirty = true;
      else for (const id of members) if (id !== skipId) this.refresh(profile, id, classify);
    }
  }
  private refresh(profile: Profile, id: string, classify: Classifier): void {
    this.refreshedKeys++;
    const prior = profile.membership.get(id)!;
    const members = profile.cohorts.get(prior)!;
    members.delete(this.order.get(id)!);
    if (!members.size) profile.cohorts.delete(prior);
    this.insert(profile, id, classify);
    if (!profile.ranked && profile.cohorts.size > RANK_THRESHOLD) profile.rankDirty = true;
  }
  inspect() {
    return {
      catalogSize: this.ids.length,
      builds: this.builds,
      scannedKeys: this.scannedKeys,
      profileCount: this.profiles.size,
      cohortCount: [...this.profiles.values()].reduce(
        (sum, profile) => sum + profile.cohorts.size,
        0,
      ),
      lastInspected: this.lastInspected,
      refreshedKeys: this.refreshedKeys,
      rankBuilds: this.rankBuilds,
      rankWork: this.rankWork,
      invalidatedMembers: this.invalidatedMembers,
    };
  }
}
