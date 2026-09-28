import { CRASH_BACKOFF_MS, CRASH_WINDOW_MS, type CrashBudgetSnapshot } from "../contracts.js";

export class CrashBudget {
  private windowStartedAt: number | undefined;
  private crashCount = 0;

  public constructor(private readonly options: { now?: () => number } = {}) {}

  public recordCrash(): { shouldRestart: boolean; delayMs: number; exhausted: boolean } {
    const now = this.options.now?.() ?? Date.now();
    if (this.windowStartedAt === undefined || now - this.windowStartedAt >= CRASH_WINDOW_MS) {
      this.windowStartedAt = now;
      this.crashCount = 0;
    }
    const index = this.crashCount;
    this.crashCount += 1;
    const delayMs = CRASH_BACKOFF_MS[Math.min(index, CRASH_BACKOFF_MS.length - 1)] ?? 0;
    const exhausted = index >= CRASH_BACKOFF_MS.length;
    return { shouldRestart: !exhausted, delayMs, exhausted };
  }

  public reset(): void {
    this.windowStartedAt = undefined;
    this.crashCount = 0;
  }

  public snapshot(): CrashBudgetSnapshot {
    const now = this.options.now?.() ?? Date.now();
    if (this.windowStartedAt !== undefined && now - this.windowStartedAt >= CRASH_WINDOW_MS) {
      this.reset();
    }
    const nextRestartDelayMs =
      this.crashCount < CRASH_BACKOFF_MS.length ? (CRASH_BACKOFF_MS[this.crashCount] ?? 0) : 0;
    return {
      ...(this.windowStartedAt === undefined ? {} : { windowStartedAt: this.windowStartedAt }),
      crashCount: this.crashCount,
      nextRestartDelayMs,
      exhausted: this.crashCount > CRASH_BACKOFF_MS.length,
    };
  }
}
