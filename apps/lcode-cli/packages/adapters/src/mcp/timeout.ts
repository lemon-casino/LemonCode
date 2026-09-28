export class McpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpTimeoutError";
  }
}

export interface McpDeadline {
  expiresAt: number;
  timeoutMs: number;
}

export function createMcpDeadline(timeoutMs: number): McpDeadline {
  const normalizedTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  return {
    expiresAt: Date.now() + normalizedTimeoutMs,
    timeoutMs: normalizedTimeoutMs,
  };
}

export function remainingMcpDeadlineMs(deadline: McpDeadline, timeoutMessage: string): number {
  const remainingMs = deadline.expiresAt - Date.now();
  if (remainingMs <= 0) {
    throw new McpTimeoutError(timeoutMessage);
  }
  return remainingMs;
}

/**
 * 只限制当前 waiter，不取消传入的共享 promise。底层任务是否取消由自己的 owner signal 决定。
 */
export function waitWithinMcpDeadline<T>(
  promise: Promise<T>,
  deadline: McpDeadline,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return withTimeout(
    promise,
    remainingMcpDeadlineMs(deadline, timeoutMessage),
    timeoutMessage,
    signal,
  );
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(
        signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"),
      );
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new McpTimeoutError(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
    };

    const abortHandler = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(
        signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"),
      );
    };

    signal?.addEventListener("abort", abortHandler);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(error);
      },
    );
  });
}
