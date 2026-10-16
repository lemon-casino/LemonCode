export interface RateLimitHint {
  readonly scope: "key" | "model" | "pool" | "provider" | "shared";
  readonly delayMs: number;
}
export const MAX_RATE_LIMIT_DELAY_MS = 86_400_000;

export function readRateLimitScope(
  headers: Pick<Headers, "get">,
): RateLimitHint["scope"] | undefined {
  const raw = headers.get("x-lcode-rate-limit-scope")?.trim().toLowerCase();
  return raw === "key" ||
    raw === "model" ||
    raw === "pool" ||
    raw === "provider" ||
    raw === "shared"
    ? raw
    : undefined;
}

/** 仅信任显式网关作用域契约；剩余额度头或错误文本不能证明每把 Key 有独立额度。 */
export function readRateLimitHint(
  headers: Pick<Headers, "get">,
  wallNow = Date.now(),
): RateLimitHint {
  const scope = readRateLimitScope(headers) ?? "provider";
  const milliseconds = nonNegative(headers.get("retry-after-ms"));
  const retryAfter = headers.get("retry-after")?.trim();
  const seconds = nonNegative(retryAfter ?? null);
  const date = retryAfter && /^[A-Za-z]{3}, /u.test(retryAfter) ? Date.parse(retryAfter) : NaN;
  const value =
    milliseconds ??
    (seconds !== undefined
      ? seconds * 1000
      : Number.isFinite(date)
        ? Math.max(0, date - wallNow)
        : 1000);
  return { scope, delayMs: Math.min(MAX_RATE_LIMIT_DELAY_MS, value) };
}

function nonNegative(value: string | null): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 实例由执行 owner 持有；不同代次可以引用同一共同窗口，不建立全局限流状态。 */
export class RateLimitWindow {
  private deadline = 0;
  private readonly closing = new AbortController();
  constructor(readonly now: () => number = () => performance.now()) {}
  get signal(): AbortSignal {
    return this.closing.signal;
  }
  remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }
  extend(delayMs: number): void {
    this.deadline = Math.max(
      this.deadline,
      this.now() + Math.min(MAX_RATE_LIMIT_DELAY_MS, Math.max(0, delayMs)),
    );
  }
  async wait(signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.signal]) : this.signal;
    for (;;) {
      combined.throwIfAborted();
      const remaining = this.remainingMs();
      if (remaining === 0) return;
      await waitForRateLimitDelay(remaining, combined);
    }
  }
  dispose(): void {
    this.closing.abort(new DOMException("Rate limit owner disposed", "AbortError"));
  }
}

export async function waitForRateLimitDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.ceil(delayMs));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
