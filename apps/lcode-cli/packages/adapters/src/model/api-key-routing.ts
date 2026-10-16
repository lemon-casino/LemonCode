import { randomUUID } from "node:crypto";
import {
  RoutingScheduler,
  type ProviderRoutingPolicy,
  type RoutingCandidate,
  type RoutingRequest,
  type RoutingWindow,
} from "@lcode/provider";

const WORK_QUANTUM = 4096;
/** API Key 原池的派生投影。未知额度不从 Key 配置或历史费用倒推。 */
export class ApiKeyRouting {
  private scheduler?: RoutingScheduler;
  private signature?: string;
  private readonly windows = new Map<string, RoutingWindow[]>();
  private revision = 0;
  get enabled(): boolean {
    return this.scheduler !== undefined;
  }

  configure(policy?: ProviderRoutingPolicy | null): void {
    const signature = JSON.stringify(policy ?? null);
    if (this.signature === signature) return;
    this.signature = signature;
    if (!policy) {
      this.scheduler?.dispose();
      this.scheduler = undefined;
      return;
    }
    if (this.scheduler) this.scheduler.setPolicy(policy);
    else this.scheduler = new RoutingScheduler(policy);
  }

  reserve(ids: readonly string[], unavailable: (id: string) => boolean, request?: RoutingRequest) {
    if (!this.scheduler) return undefined;
    const candidates: RoutingCandidate[] = ids.map((id) => ({
      id,
      generation: "pool",
      portability: "portable",
      windows: this.windows.get(id) ?? [],
      ...(unavailable(id) ? { unavailable: "route-cooling" } : {}),
    }));
    const demands: Record<string, number> = { ...request?.demands };
    for (const candidate of candidates)
      for (const window of candidate.windows)
        if (window.unit === "requests") demands[window.resourceId] = 1;
    return this.scheduler.reserve(
      candidates,
      request
        ? { ...request, demands }
        : { attemptId: randomUUID(), scopeKey: randomUUID(), workUnits: WORK_QUANTUM, demands },
    );
  }

  observe(id: string, headers: Headers): void {
    const windows: RoutingWindow[] = [];
    for (const unit of ["requests", "tokens"] as const) {
      const rawRemaining = headers.get(`x-ratelimit-remaining-${unit}`);
      const rawLimit = headers.get(`x-ratelimit-limit-${unit}`);
      if (rawRemaining === null || rawLimit === null) continue;
      const remaining = Number(rawRemaining),
        limit = Number(rawLimit);
      if (!Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(limit) || limit <= 0)
        continue;
      const reset = headers.get(`x-ratelimit-reset-${unit}`);
      const resourceId = JSON.stringify([id, unit]);
      // duration 格式不能当作绝对窗口 ID；缺少可证实例时沿用当前保守增量。
      const resetAt = reset && /^\d{4}-/u.test(reset) ? Date.parse(reset) : NaN;
      windows.push({
        resourceId,
        instanceId: Number.isFinite(resetAt) ? String(resetAt) : "unverified-period",
        revision: ++this.revision,
        kind: "rate",
        quality: "fresh",
        remaining,
        limit,
        unit,
        ...(Number.isFinite(resetAt) ? { resetAt } : {}),
      });
    }
    if (windows.length) this.windows.set(id, windows);
  }

  dispose(): void {
    this.scheduler?.dispose();
    this.windows.clear();
  }
}
