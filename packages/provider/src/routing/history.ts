import type {
  RoutingCandidate,
  RoutingFinish,
  RoutingWindow,
} from "@lcode/shared/provider-routing";

const OBSERVATION_WINDOW = 15 * 60_000;
const MAX_SAMPLES = 128;
const MIN_SAMPLES = 8;
const MIN_OBSERVATION = 60_000;
const FORECAST_HORIZON = 60 * 60_000;
interface Sample {
  at: number;
  elapsed: number;
  failed: boolean;
  resolved: boolean;
  usage: RoutingFinish;
}

/** 仅记录本 owner 的物理样本。缺少用量、时间跨度或同单位窗口就不生成到期预测。 */
export class RoutingHistory {
  private readonly samples = new Map<string, Sample[]>();
  private readonly resources = new Map<string, Sample[]>();
  private key(candidate: RoutingCandidate) {
    return JSON.stringify([candidate.id, candidate.generation]);
  }
  record(candidate: RoutingCandidate, at: number, started: number, usage: RoutingFinish): Sample {
    const key = this.key(candidate),
      samples = this.samples.get(key) ?? [];
    const sample = {
      at,
      elapsed: Math.max(0, at - started),
      failed: usage.outcome === "failed",
      resolved: usage.outcome !== "unknown" && usage.outcome !== "cancelled",
      usage,
    };
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
    return sample;
  }
  project(
    candidate: RoutingCandidate,
    now: number,
    available: (window: RoutingWindow) => number | undefined,
  ): RoutingCandidate {
    const samples = (this.samples.get(this.key(candidate)) ?? []).filter(
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
          });
    const result = { ...candidate, statistics };
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
  }
  nextChange(candidate: RoutingCandidate, now: number): number {
    return Math.min(
      Infinity,
      ...(this.samples.get(this.key(candidate)) ?? [])
        .map((sample) => sample.at + OBSERVATION_WINDOW + 1)
        .filter((at) => at > now),
    );
  }
}
