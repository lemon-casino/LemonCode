import { RoutingError } from "@lcode/provider";
import type { RoutingUsage } from "@lcode/shared";
const TERMINAL_TTL = 5 * 60_000,
  CAPACITY = 4096;
/** 原调度 owner 的归因索引；活跃/未确认反馈不能按签发时间淘汰。 */
export class ProviderRoutingFeedback {
  private readonly entries = new Map<
    string,
    {
      observe: (usage: RoutingUsage) => void;
      physical: boolean;
      normalized: boolean;
      expires: number;
    }
  >();
  constructor(private readonly now: () => number) {}
  retain(key: string, observe: (usage: RoutingUsage) => void) {
    for (const [id, entry] of this.entries)
      if (entry.expires <= this.now()) this.entries.delete(id);
    if (this.entries.size >= CAPACITY && !this.entries.has(key)) {
      const terminal = [...this.entries].find(([, item]) => item.physical && item.normalized);
      if (terminal) this.entries.delete(terminal[0]);
      else throw new RoutingError("quota-owner-capacity", { phase: "feedback" });
    }
    const entry = { observe, physical: false, normalized: false, expires: Infinity };
    this.entries.set(key, entry);
    return {
      finish: () => {
        entry.physical = true;
        if (entry.normalized) entry.expires = this.now() + TERMINAL_TTL;
      },
      cancel: () => {
        this.entries.delete(key);
      },
    };
  }
  observe(key: string, usage: RoutingUsage) {
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= this.now())
      throw new RoutingError("owner-stale", { phase: "feedback" });
    entry.observe(usage);
    if (usage.outcome) {
      entry.normalized = true;
      if (entry.physical) entry.expires = this.now() + TERMINAL_TTL;
    }
  }
  inspect() {
    let unresolved = 0;
    for (const entry of this.entries.values())
      if (!entry.physical || !entry.normalized) unresolved++;
    return { retained: this.entries.size, unresolved, capacity: CAPACITY };
  }
  clear() {
    this.entries.clear();
  }
}
