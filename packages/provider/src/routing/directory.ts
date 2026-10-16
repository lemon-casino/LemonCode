import type { RoutingCandidate, RoutingRequest } from "@lcode/shared/provider-routing";
import { RoutingScoreGroups } from "./score-groups.js";
import { RoutingTournament } from "./tournament.js";
import type { RoutingRank } from "./ranking.js";
type Classifier = (
  candidate: RoutingCandidate,
  request: RoutingRequest,
) => { rank: RoutingRank; expires?: number };
interface Profile {
  request: RoutingRequest;
  ranked?: RoutingTournament;
  groups?: RoutingScoreGroups;
  builder?: Generator<void, void, void>;
  dirty: Set<string>;
  rankDirty: boolean;
}
const PROFILE_LIMIT = 8,
  PROFILE_MEMBER_BUDGET = 200000,
  CHUNK = 128;
/** 可丢弃的紧凑投影；共享 builder 只由调用者驱动，不拥有业务队列、预留或异步 IO。 */
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
  private readonly groups = new Map<string, string | Set<string>>();
  constructor(
    readonly sourceIds: readonly string[],
    readonly read: (id: string, request?: RoutingRequest) => RoutingCandidate,
    policyOrder?: readonly string[],
  ) {
    if (policyOrder?.length) {
      const present = new Set(sourceIds),
        leading = policyOrder.filter((id) => present.has(id)),
        listed = new Set(leading);
      this.ids = [...leading, ...sourceIds.filter((id) => !listed.has(id))];
    } else this.ids = [...sourceIds];
    const order = new Map<string, number>();
    for (let index = 0; index < this.ids.length; index++) order.set(this.ids[index]!, index);
    this.order = order;
  }
  private key(request: RoutingRequest): string {
    return JSON.stringify([request.tokens, request.workUnits, request.demands, request.modelKey]);
  }
  private get capacity(): number {
    return Math.min(
      PROFILE_LIMIT,
      Math.max(1, Math.floor(PROFILE_MEMBER_BUDGET / Math.max(1, this.ids.length))),
    );
  }
  ready(request: RoutingRequest, now: number): boolean {
    const profile = this.profiles.get(this.key(request));
    return Boolean(
      profile &&
      !profile.builder &&
      !profile.rankDirty &&
      !profile.dirty.size &&
      (profile.groups ?? profile.ranked)!.nextAt > now,
    );
  }
  *prepare(
    request: RoutingRequest,
    classify: Classifier,
    now: () => number,
  ): Generator<void, void, void> {
    const key = this.key(request);
    let profile = this.profiles.get(key);
    if (!profile) {
      if (this.profiles.size >= this.capacity)
        this.profiles.delete(this.profiles.keys().next().value!);
      const input = {
        ...request,
        attemptId: "index",
        scopeKey: "index",
        turnId: undefined,
        signal: undefined,
        tokens: request.tokens ? { ...request.tokens } : undefined,
        demands: request.demands ? { ...request.demands } : undefined,
      };
      profile = {
        request: input,
        ranked: new RoutingTournament(this.ids, input),
        groups: new RoutingScoreGroups(),
        dirty: new Set(),
        rankDirty: true,
      };
      this.profiles.set(key, profile);
      this.builds++;
    }
    this.profiles.delete(key);
    this.profiles.set(key, profile);
    while (this.profiles.get(key) === profile) {
      if (!profile.builder && profile.rankDirty) {
        profile.rankDirty = false;
        profile.builder = this.rebuild(profile, classify);
      }
      if (profile.builder) {
        if (profile.builder.next().done) profile.builder = undefined;
        else {
          yield;
          continue;
        }
      }
      if (profile.dirty.size) {
        let count = 0;
        for (const id of profile.dirty) {
          profile.dirty.delete(id);
          this.refresh(profile, id, classify);
          if (++count === CHUNK) break;
        }
        yield;
        continue;
      }
      const due = (profile.groups ?? profile.ranked)!.takeDue(now(), CHUNK);
      if (due.length) {
        for (const id of due) this.refresh(profile, id, classify);
        yield;
        continue;
      }
      return;
    }
  }
  private *rebuild(profile: Profile, classify: Classifier): Generator<void, void, void> {
    profile.ranked ??= new RoutingTournament(this.ids, profile.request);
    if (profile.groups) profile.groups = new RoutingScoreGroups();
    for (let index = 0; index < this.ids.length; index++) {
      this.scannedKeys++;
      const measured = this.rank(profile, this.ids[index]!, classify);
      profile.ranked.seed(measured.rank);
      profile.groups?.update(measured.rank, measured.expires ?? measured.rank.expires);
      if (profile.groups?.overflow) profile.groups = undefined;
      if ((index + 1) % CHUNK === 0) yield;
    }
    if (profile.groups) profile.ranked = undefined;
    else {
      yield* profile.ranked.finish();
      this.rankBuilds++;
    }
  }
  private rank(profile: Profile, id: string, classify: Classifier) {
    const candidate = this.read(id, profile.request);
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
      const members = this.groups.get(group);
      if (!members) this.groups.set(group, id);
      else if (typeof members === "string") {
        if (members !== id) this.groups.set(group, new Set([members, id]));
      } else members.add(id);
    }
    return classify(candidate, profile.request);
  }
  select(
    request: RoutingRequest,
    cursor: number,
    classify: Classifier,
    now: number,
    binding?: string,
    round = 0,
  ): RoutingCandidate[] {
    for (const _ of this.prepare(request, classify, () => now)) {
    }
    const profile = this.profiles.get(this.key(request))!;
    const selected = profile.groups
      ? profile.groups.select(this.ids, cursor)
      : profile.ranked!.select(cursor, round);
    this.rankWork = selected.work;
    const result = selected.ids.map((id) => this.read(id, request));
    if (binding && this.order.has(binding) && !result.some((candidate) => candidate.id === binding))
      result.push(this.read(binding, request));
    this.lastInspected = result.length;
    return result;
  }
  touch(id: string, classify: Classifier): void {
    if (!this.order.has(id)) return;
    for (const profile of this.profiles.values()) {
      if (profile.builder || profile.rankDirty) profile.dirty.add(id);
      else this.refresh(profile, id, classify);
    }
  }
  touchGroupFor(id: string, classify: Classifier): void {
    const group = this.groupById.get(id);
    if (group) this.touchGroup(group, classify, id);
  }
  touchGroup(group: string, classify: Classifier, skipId?: string): void {
    const members = this.groups.get(group);
    if (!members) return;
    const count = typeof members === "string" ? 1 : members.size;
    for (const profile of this.profiles.values()) {
      this.invalidatedMembers += count;
      if (profile.groups && !profile.builder && !profile.rankDirty) continue;
      if (count > CHUNK) profile.rankDirty = true;
      else
        for (const id of typeof members === "string" ? [members] : members)
          if (id !== skipId) {
            if (profile.builder) profile.dirty.add(id);
            else this.refresh(profile, id, classify);
          }
    }
  }
  private refresh(profile: Profile, id: string, classify: Classifier): void {
    this.refreshedKeys++;
    const measured = this.rank(profile, id, classify);
    if (profile.groups) {
      profile.groups.update(measured.rank, measured.expires ?? measured.rank.expires);
      if (profile.groups.overflow) {
        profile.groups = undefined;
        profile.rankDirty = true;
      }
    } else profile.ranked!.update(measured.rank);
  }
  inspect() {
    return {
      catalogSize: this.ids.length,
      builds: this.builds,
      scannedKeys: this.scannedKeys,
      profileCount: this.profiles.size,
      profileCapacity: this.capacity,
      cohortCount: [...this.profiles.values()].reduce(
        (sum, profile) => sum + (profile.groups?.size ?? 0),
        0,
      ),
      rankedEntries:
        [...this.profiles.values()].filter((profile) => profile.ranked).length * this.ids.length,
      preparing: [...this.profiles.values()].filter(
        (profile) => profile.builder || profile.rankDirty,
      ).length,
      lastInspected: this.lastInspected,
      refreshedKeys: this.refreshedKeys,
      rankBuilds: this.rankBuilds,
      rankWork: this.rankWork,
      invalidatedMembers: this.invalidatedMembers,
    };
  }
}
