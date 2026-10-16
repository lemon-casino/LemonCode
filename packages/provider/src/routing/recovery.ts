import { RoutingError } from "./error.js";

export interface RoutingRecoveryEntry {
  revision: number;
  failedFrom?: number;
  retryAt: number;
  phase: "healthy" | "cooling" | "probing" | "uncertain";
  probe?: string;
  dispatched?: boolean;
  physicalEnded?: boolean;
  outcome?: "success" | "failed" | "cancelled";
}
export interface RoutingRecoveryPermit {
  token: string;
  versions: Record<string, number>;
  probes: string[];
  dispatched?: boolean;
  physicalEnded?: boolean;
  outcome?: "success" | "failed" | "cancelled";
  failures?: Record<string, number>;
  closed?: boolean;
}
const FAILURE_BACKOFF_MS = 1000;

/** 原 owner 的恢复状态；不拥有额度、执行预算、定时器或第二条队列。传入记录可由 adapter 原子持久化。 */
export class RoutingRecovery {
  private readonly permits = new Map<string, RoutingRecoveryPermit>();
  /** 健康墓碑仅在所有引用退休后回收；closed permit 不能从 revision=0 复活旧故障。 */
  compact(live: Iterable<RoutingRecoveryPermit> = this.permits.values()): void {
    const referenced = new Set<string>();
    for (const permit of live)
      if (!permit.closed) for (const key of Object.keys(permit.versions)) referenced.add(key);
    for (const [key, entry] of Object.entries(this.state))
      if (entry.phase === "healthy" && !referenced.has(key)) delete this.state[key];
  }
  private close(permit: RoutingRecoveryPermit): void {
    if (!permit.physicalEnded || (permit.outcome !== "success" && permit.outcome !== "failed"))
      return;
    if (permit.probes.some((key) => this.matches(permit, key))) return;
    permit.closed = true;
    this.permits.delete(permit.token);
    this.compact();
  }
  constructor(
    private readonly state: Record<string, RoutingRecoveryEntry> = Object.create(null),
    live: Iterable<RoutingRecoveryPermit> = [],
  ) {
    for (const permit of live) if (!permit.closed) this.permits.set(permit.token, permit);
  }
  private get(key: string) {
    return Object.hasOwn(this.state, key) ? this.state[key] : undefined;
  }
  available(keys: readonly string[], now: number): boolean {
    return keys.every((key) => {
      const entry = this.get(key);
      return (
        !entry || entry.phase === "healthy" || (entry.phase === "cooling" && entry.retryAt <= now)
      );
    });
  }
  retryAt(keys: readonly string[]): number | undefined {
    const entries = keys
      .map((key) => this.get(key))
      .filter((entry): entry is RoutingRecoveryEntry =>
        Boolean(entry && entry.phase !== "healthy"),
      );
    if (!entries.length || entries.some((entry) => entry.phase !== "cooling")) return undefined;
    return Math.max(...entries.map((entry) => entry.retryAt));
  }

  reserve(keys: readonly string[], token: string, now: number): RoutingRecoveryPermit {
    const versions: Record<string, number> = {},
      probes: string[] = [];
    for (const key of new Set(keys)) {
      const entry = this.get(key);
      if (
        entry &&
        entry.phase !== "healthy" &&
        entry.probe !== token &&
        (entry.phase !== "cooling" || entry.retryAt > now)
      )
        throw new RoutingError("route-cooling", {
          retryAt: entry.phase === "cooling" ? entry.retryAt : undefined,
          phase: "admission",
        });
    }
    for (const key of new Set(keys)) {
      const entry = this.get(key);
      if (entry && entry.phase !== "healthy") {
        if (entry.probe !== token) {
          entry.revision++;
          entry.phase = "probing";
          entry.probe = token;
          entry.dispatched = false;
          entry.physicalEnded = false;
          delete entry.outcome;
          delete entry.failedFrom;
        }
        probes.push(key);
      }
      versions[key] = entry?.revision ?? 0;
    }
    const permit = { token, versions, probes };
    this.permits.set(token, permit);
    return permit;
  }
  private matches(permit: RoutingRecoveryPermit, key: string): RoutingRecoveryEntry | undefined {
    if (permit.closed) return undefined;
    const entry = this.get(key);
    return entry && entry.probe === permit.token && entry.revision === permit.versions[key]
      ? entry
      : undefined;
  }
  dispatch(permit: RoutingRecoveryPermit, now: number): void {
    if (permit.closed) throw new RoutingError("owner-stale");
    for (const [key, revision] of Object.entries(permit.versions)) {
      const entry = this.get(key);
      if (
        (entry?.revision ?? 0) !== revision ||
        (entry && entry.phase !== "healthy" && entry.probe !== permit.token)
      )
        throw new RoutingError("route-cooling", {
          phase: "dispatch",
          retryAt: entry?.phase === "cooling" && entry.retryAt > now ? entry.retryAt : undefined,
        });
    }
    permit.dispatched = true;
    for (const key of permit.probes) {
      const entry = this.matches(permit, key);
      if (entry) entry.dispatched = true;
    }
  }
  cancel(permit: RoutingRecoveryPermit): void {
    if (permit.dispatched) return;
    for (const key of permit.probes) {
      const entry = this.matches(permit, key);
      if (!entry || entry.dispatched) continue;
      entry.phase = "cooling";
      entry.revision++;
      delete entry.probe;
    }
    permit.closed = true;
    this.permits.delete(permit.token);
    this.compact();
  }
  /** 仅 adapter 已证明尚未 fetch 时调用；网络失败不具备此证明。 */
  rollbackUnsent(permit: RoutingRecoveryPermit): void {
    permit.dispatched = false;
    for (const key of permit.probes) {
      const entry = this.matches(permit, key);
      if (entry) entry.dispatched = false;
    }
    this.cancel(permit);
  }
  fail(permit: RoutingRecoveryPermit, keys: readonly string[], retryAt: number): void {
    if (permit.closed) return;
    for (const key of keys) {
      if (!Object.hasOwn(permit.versions, key)) continue;
      const failures = (permit.failures ??= {});
      if (Object.hasOwn(failures, key)) continue;
      failures[key] = retryAt;
      const previous = this.get(key);
      // 同一健康代次的并发失败合并最晚截止；probe 换代后迟到失败不再有写权限。
      if (previous?.phase === "cooling" && previous.failedFrom === permit.versions[key]) {
        previous.retryAt = Math.max(previous.retryAt, retryAt);
        continue;
      }
      if ((previous?.revision ?? 0) !== permit.versions[key]) continue;
      this.state[key] = {
        revision: (previous?.revision ?? 0) + 1,
        retryAt: Math.max(retryAt, previous?.retryAt ?? 0),
        phase: "cooling",
        failedFrom: permit.versions[key],
      };
    }
  }
  private settle(entry: RoutingRecoveryEntry, now: number): void {
    if (!entry.physicalEnded) return;
    if (entry.outcome === "success") {
      entry.phase = "healthy";
      entry.retryAt = 0;
      entry.revision++;
      delete entry.probe;
    } else if (entry.outcome === "failed") {
      entry.phase = "cooling";
      entry.retryAt = now + FAILURE_BACKOFF_MS;
      entry.revision++;
      delete entry.probe;
    } else entry.phase = "uncertain";
  }
  observe(
    permit: RoutingRecoveryPermit,
    outcome: "success" | "failed" | "cancelled" | "unknown" | undefined,
    now: number,
  ): void {
    if (permit.closed) return;
    if (outcome !== undefined && outcome !== "unknown") permit.outcome ??= outcome;
    for (const key of permit.probes) {
      const entry = this.matches(permit, key);
      if (!entry) continue;
      if (outcome !== undefined && outcome !== "unknown") entry.outcome ??= outcome;
      this.settle(entry, now);
    }
    this.close(permit);
  }
  finish(
    permit: RoutingRecoveryPermit,
    outcome: "success" | "failed" | "cancelled" | "unknown",
    now: number,
  ): void {
    if (permit.closed) return;
    permit.physicalEnded = true;
    for (const key of permit.probes) {
      const entry = this.matches(permit, key);
      if (entry) entry.physicalEnded = true;
    }
    this.observe(permit, outcome, now);
  }
  count(filter?: (resource: string) => boolean) {
    return Object.keys(this.state).filter((resource) => !filter || filter(resource)).length;
  }
  inspect(now: number, offset = 0, limit = 100, filter?: (resource: string) => boolean) {
    return Object.entries(this.state)
      .filter(([resource]) => !filter || filter(resource))
      .slice(offset, offset + Math.max(1, Math.min(100, limit)))
      .map(([resource, entry]) => ({
        resource,
        revision: entry.revision,
        phase: entry.phase === "cooling" && entry.retryAt <= now ? "probe-eligible" : entry.phase,
        retryAt: entry.phase === "cooling" ? entry.retryAt : undefined,
      }));
  }
  clear(): void {
    for (const key of Object.keys(this.state)) delete this.state[key];
    this.permits.clear();
  }
}
