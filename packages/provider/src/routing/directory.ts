import type { RoutingCandidate, RoutingRequest } from "@lcode/shared/provider-routing";
import { RoutingOrderedSet } from "./ordered-set.js";
import { RoutingDeadlineIndex } from "./deadline-index.js";
interface Profile {
  request: RoutingRequest;
  cohorts: Map<string, RoutingOrderedSet>;
  membership: Map<string, string>;
  deadlines: RoutingDeadlineIndex;
}
const PROFILE_LIMIT = 8;
/** 只索引当前需求下等价的目录位置；余额、份额和绑定仍由 Scheduler 拥有。 */
export class RoutingDirectory {
  readonly order: ReadonlyMap<string, number>;
  readonly ids: readonly string[];
  private readonly profiles = new Map<string, Profile>();
  private builds = 0;
  private scannedKeys = 0;
  private lastInspected = 0;
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
    classify: (
      candidate: RoutingCandidate,
      request: RoutingRequest,
    ) => { key: string; expires: number },
    now: number,
    binding?: string,
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
      for (const id of this.ids) {
        this.scannedKeys++;
        this.insert(profile, id, classify);
      }
      if (this.profiles.size >= PROFILE_LIMIT)
        this.profiles.delete(this.profiles.keys().next().value!);
    }
    this.profiles.delete(key);
    this.profiles.set(key, profile);
    const result: RoutingCandidate[] = [];
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
  private insert(
    profile: Profile,
    id: string,
    classify: (
      candidate: RoutingCandidate,
      request: RoutingRequest,
    ) => { key: string; expires: number },
  ): void {
    const result = classify(this.read(id), profile.request);
    let members = profile.cohorts.get(result.key);
    if (!members) {
      members = new RoutingOrderedSet();
      profile.cohorts.set(result.key, members);
    }
    members.add(this.order.get(id)!);
    profile.membership.set(id, result.key);
    profile.deadlines.set(id, result.expires);
  }
  touch(
    id: string,
    classify: (
      candidate: RoutingCandidate,
      request: RoutingRequest,
    ) => { key: string; expires: number },
  ): void {
    if (!this.order.has(id)) return;
    for (const profile of this.profiles.values()) this.refresh(profile, id, classify);
  }
  private refresh(
    profile: Profile,
    id: string,
    classify: (
      candidate: RoutingCandidate,
      request: RoutingRequest,
    ) => { key: string; expires: number },
  ): void {
    const prior = profile.membership.get(id)!;
    const members = profile.cohorts.get(prior)!;
    members.delete(this.order.get(id)!);
    if (!members.size) profile.cohorts.delete(prior);
    this.insert(profile, id, classify);
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
    };
  }
}
