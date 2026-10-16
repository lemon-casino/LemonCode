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
    if (samples.length < MIN_SAMPLES) return candidate;
    const statistics = candidate.statistics ?? {
      samples: samples.length,
      failureRate: samples.filter((item) => item.failed).length / samples.length,
      completionMs: samples.reduce((sum, item) => sum + item.elapsed, 0) / samples.length,
    };
    const result = { ...candidate, statistics };
    if (candidate.expiry || now - samples[0]!.at < MIN_OBSERVATION) return result;
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
      const measured = samples.filter(
        (sample) => sample.usage.actualDemands?.[window.resourceId] !== undefined,
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
  }
}
