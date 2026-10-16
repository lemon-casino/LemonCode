import type {
  RoutingCandidate,
  RoutingFinish,
  RoutingWindow,
} from "@lcode/shared/provider-routing";

const OBSERVATION_WINDOW = 15 * 60_000;
const MAX_BUCKETS = 8192;
const WORK_HALF_LIFE = 3_600_000;
const MAX_SAMPLES = 128;
const MIN_SAMPLES = 8;
const MIN_OBSERVATION = 60_000;
const FORECAST_HORIZON = 60 * 60_000;
export const routingHealthRelevant = (usage: RoutingFinish) =>
  usage.outcome !== "cancelled" &&
  usage.outcome !== "unknown" &&
  !(
    usage.statusCode !== undefined &&
    usage.statusCode >= 400 &&
    usage.statusCode < 500 &&
    usage.statusCode !== 429
  );
interface Sample {
  at: number;
  elapsed: number;
  serviceElapsed: number;
  key: string;
  work: number;
  failed: boolean;
  resolved: boolean;
  usage: RoutingFinish;
}

/** 仅记录本 owner 的物理样本。缺少用量、时间跨度或同单位窗口就不生成到期预测。 */
export class RoutingHistory {
  constructor(private readonly invalidate?: (routeId: string) => void) {}
  private evicted(key: string): void {
    this.invalidate?.((JSON.parse(key) as [string])[0]);
  }
  private readonly samples = new Map<string, Sample[]>();
  private readonly resources = new Map<string, Sample[]>();
  private readonly recent = new Map<string, { units: number; at: number }>();
  private addWork(key: string, units: number, at: number): void {
    const old = this.recent.get(key);
    this.recent.delete(key);
    this.recent.set(key, {
      at,
      units: Math.max(
        0,
        (old ? old.units * 2 ** (-Math.max(0, at - old.at) / WORK_HALF_LIFE) : 0) + units,
      ),
    });
    while (this.recent.size > MAX_BUCKETS) {
      const oldest = this.recent.keys().next().value!;
      this.recent.delete(oldest);
      // 统计淘汰也是原 owner 的事实变化；否则紧凑索引会长期保留已不存在的工作量。
      this.evicted(oldest);
    }
  }
  updateWork(sample: Sample, actual: number, now: number): void {
    // 迟到用量只调整这一笔原估计，已被淘汰的统计桶不从旧反馈复活。
    if (this.recent.has(sample.key))
      this.addWork(
        sample.key,
        (actual - sample.work) * 2 ** (-Math.max(0, now - sample.at) / WORK_HALF_LIFE),
        now,
      );
    sample.work = actual;
  }
  private key(candidate: RoutingCandidate, modelKey?: string) {
    return JSON.stringify([candidate.id, candidate.generation, modelKey ?? null]);
  }
  record(
    candidate: RoutingCandidate,
    at: number,
    started: number,
    usage: RoutingFinish,
    modelKey?: string,
    admittedAt = started,
    estimatedWork = 1,
  ): Sample {
    const key = this.key(candidate, modelKey),
      samples = this.samples.get(key) ?? [];
    const sample = {
      at,
      elapsed: Math.max(0, at - started) + Math.max(0, started - admittedAt),
      serviceElapsed: Math.max(0, at - started),
      key,
      work: usage.workUnits ?? estimatedWork,
      failed: usage.outcome === "failed",
      resolved: routingHealthRelevant(usage),
      usage,
    };
    this.addWork(key, sample.work, at);
    samples.push(sample);
    this.samples.set(
      key,
      samples.filter((item) => item.at >= at - OBSERVATION_WINDOW).slice(-MAX_SAMPLES),
    );
    for (const resource of new Set(
      candidate.windows.map((window) => JSON.stringify([window.resourceId, window.instanceId])),
    )) {
      const readings = this.resources.get(resource) ?? [];
      this.resources.set(
        resource,
        [...readings.filter((item) => item.at >= at - OBSERVATION_WINDOW), sample].slice(
          -MAX_SAMPLES,
        ),
      );
    }
    // 样本属于可丢弃的统计投影，不能让十万 Key × 模型历史无限累积。
    for (const map of [this.samples, this.resources])
      while (map.size > MAX_BUCKETS) {
        const oldest = map.keys().next().value!;
        map.delete(oldest);
        if (map === this.samples) this.evicted(oldest);
      }
    return sample;
  }
  project(
    candidate: RoutingCandidate,
    now: number,
    available: (window: RoutingWindow) => number | undefined,
    modelKey?: string,
  ): RoutingCandidate {
    const samples = (this.samples.get(this.key(candidate, modelKey)) ?? []).filter(
      (item) => item.at >= now - OBSERVATION_WINDOW && item.resolved,
    );
    const statistics =
      candidate.statistics ??
      (samples.length < MIN_SAMPLES
        ? undefined
        : {
            samples: samples.length,
            failureRate: samples.filter((item) => item.failed).length / samples.length,
            completionMs: samples.reduce((sum, item) => sum + item.elapsed, 0) / samples.length,
            serviceMs: samples.reduce((sum, item) => sum + item.serviceElapsed, 0) / samples.length,
          });
    const result = {
      ...candidate,
      statistics,
      recentWork: candidate.recentWork ?? this.recent.get(this.key(candidate, modelKey)),
    };
    if (candidate.expiry) return result;
    const expiring = candidate.windows.filter(
      (window) =>
        window.kind === "expiring-balance" &&
        window.quality === "fresh" &&
        window.expiresAt &&
        window.expiresAt > now &&
        window.expiresAt - now <= FORECAST_HORIZON &&
        window.remaining !== undefined &&
        window.unit,
    );
    for (const window of expiring) {
      const measured = (
        this.resources.get(JSON.stringify([window.resourceId, window.instanceId])) ?? []
      ).filter(
        (sample) =>
          sample.at >= now - OBSERVATION_WINDOW &&
          sample.resolved &&
          sample.usage.actualDemands?.[window.resourceId] !== undefined,
      );
      if (measured.length < MIN_SAMPLES) continue;
      const span = now - measured[0]!.at;
      if (span < MIN_OBSERVATION) continue;
      const rate =
        measured.reduce((sum, sample) => sum + sample.usage.actualDemands![window.resourceId]!, 0) /
        span;
      const remaining = available(window);
      if (remaining === undefined) continue;
      const predictedWaste = Math.max(0, remaining - rate * (window.expiresAt! - now));
      return {
        ...result,
        expiry: {
          expiresAt: window.expiresAt!,
          predictedWaste,
          comparableUnit: window.unit!,
          confidence: "estimated",
          resourceId: window.resourceId,
        },
      };
    }
    return result;
  }
  clear(): void {
    this.samples.clear();
    this.resources.clear();
    this.recent.clear();
  }
  nextChange(candidate: RoutingCandidate, now: number, modelKey?: string): number {
    return Math.min(
      Infinity,
      ...(this.samples.get(this.key(candidate, modelKey)) ?? [])
        .map((sample) => sample.at + OBSERVATION_WINDOW + 1)
        .filter((at) => at > now),
    );
  }
}
