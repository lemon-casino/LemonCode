import type { ProfilerOnRenderCallback } from "react";

const LIMIT = 2_048;

class BoundedDistribution {
  private values: number[] = [];
  count = 0;
  total = 0;
  maximum = 0;
  longCount = 0;

  add(value: number) {
    this.count++;
    this.total += value;
    this.maximum = Math.max(this.maximum, value);
    if (value > 50) this.longCount++;
    this.values[(this.count - 1) % LIMIT] = value;
  }

  result() {
    const sorted = [...this.values].sort((a, b) => a - b);
    return {
      count: this.count,
      totalMs: this.total,
      meanMs: this.count === 0 ? 0 : this.total / this.count,
      maxMs: this.maximum,
      recentP50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      recentP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      over50Ms: this.longCount,
      over50Ratio: this.count === 0 ? 0 : this.longCount / this.count,
      sampleCount: sorted.length,
      sampleCap: LIMIT,
      quantileWindow: "most recent bounded samples; totals/max/ratio cover whole measurement",
    };
  }
}

export class StressBrowserMetrics {
  private commits = new BoundedDistribution();
  private frames = new BoundedDistribution();
  private animation: number | undefined;
  private firstFrame: number | undefined;
  private previousFrame: number | undefined;
  private startedAt = 0;
  private endedAt = 0;
  errors = 0;
  recoveries = 0;
  recoveryConsistencyFailures = 0;
  staleChecks = 0;
  openedDetails = 0;
  private readonly countError = () => {
    this.errors++;
  };

  readonly onRender: ProfilerOnRenderCallback = (_id, _phase, duration) => {
    if (this.animation !== undefined) this.commits.add(duration);
  };

  start() {
    this.stop();
    this.commits = new BoundedDistribution();
    this.frames = new BoundedDistribution();
    this.firstFrame = undefined;
    this.previousFrame = undefined;
    this.startedAt = performance.now();
    this.endedAt = 0;
    this.errors = 0;
    this.recoveries = 0;
    this.recoveryConsistencyFailures = 0;
    this.staleChecks = 0;
    this.openedDetails = 0;
    window.addEventListener("error", this.countError);
    window.addEventListener("unhandledrejection", this.countError);
    const frame = (at: number) => {
      this.firstFrame ??= at;
      if (this.previousFrame !== undefined) this.frames.add(at - this.previousFrame);
      this.previousFrame = at;
      this.animation = requestAnimationFrame(frame);
    };
    this.animation = requestAnimationFrame(frame);
  }

  stop() {
    if (this.animation !== undefined) {
      cancelAnimationFrame(this.animation);
      this.animation = undefined;
      this.endedAt = performance.now();
    }
    window.removeEventListener("error", this.countError);
    window.removeEventListener("unhandledrejection", this.countError);
  }

  result() {
    const endedAt = this.endedAt || performance.now();
    const measuredWallMs = this.startedAt === 0 ? 0 : endedAt - this.startedAt;
    const raf = this.frames.result();
    const firstFrameOffsetMs =
      this.firstFrame === undefined ? null : this.firstFrame - this.startedAt;
    const lastFrameOffsetMs =
      this.previousFrame === undefined ? null : this.previousFrame - this.startedAt;
    return {
      measuredWallMs,
      commits: this.commits.result(),
      raf,
      // RAF 间隔只覆盖首帧到末帧；显式保留首尾盲区，不能从墙钟减掉或补成虚拟帧。
      rafCoverage: {
        firstFrameOffsetMs,
        lastFrameOffsetMs,
        beforeFirstFrameMs: firstFrameOffsetMs,
        afterLastFrameMs: this.previousFrame === undefined ? null : endedAt - this.previousFrame,
        intervalCoveredMs: raf.totalMs,
        unobservedEndpointMs: measuredWallMs - raf.totalMs,
        intervalCoverageRatio: measuredWallMs > 0 ? raf.totalMs / measuredWallMs : 0,
        timingBoundary:
          "RAF timestamps cover first through last observed frame only; signed endpoint offsets expose timing gaps without altering wall time or inventing frames",
      },
      errors: this.errors,
      recoveries: this.recoveries,
      recoveryConsistencyFailures: this.recoveryConsistencyFailures,
      staleChecks: this.staleChecks,
      openedDetails: this.openedDetails,
      rafRemaining: Number(this.animation !== undefined),
      errorListenersRemaining: this.animation === undefined ? 0 : 2,
    };
  }
}
