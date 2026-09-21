export async function runCancelablePool<TInput, TResult>({
  items,
  concurrency,
  shouldContinue,
  run,
  onResult,
}: {
  items: readonly TInput[];
  concurrency: number;
  shouldContinue: () => boolean;
  run: (item: TInput) => Promise<TResult>;
  onResult: (result: TResult) => void;
}): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && shouldContinue()) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        const result = await run(item);
        if (!shouldContinue()) return;
        onResult(result);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
