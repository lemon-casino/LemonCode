export async function mapWithFixedConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<Array<PromiseSettledResult<TResult>>> {
  signal?.throwIfAborted();
  const results: Array<PromiseSettledResult<TResult>> = [];
  results.length = values.length;
  let nextIndex = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index]!;
      try {
        results[index] = {
          status: "fulfilled",
          value: await awaitMemoryRecallOperation(() => mapper(value), signal),
        };
      } catch (reason) {
        try {
          // 取消不是单文件不可读；若被 allSettled 吞掉，旧队列还会继续读完整个目录。
          rethrowMemoryRecallAbort(reason, signal);
        } catch (abort) {
          stopped = true;
          throw abort;
        }
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export function rethrowMemoryRecallAbort(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && error.name === "AbortError") ||
      ("code" in error && (error.code === "cancelled" || error.code === "ABORT_ERR")))
  )
    throw error;
}

export async function awaitMemoryRecallOperation<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // 自定义端口可能忽略 signal；停止等待和后续 admission，但不声称取消了底层 IO。
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
