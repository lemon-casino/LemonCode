export function selectedModelIds(rows: readonly string[], selected: ReadonlySet<string>): string[] {
  return rows.filter((id) => selected.has(id));
}

export async function runSequentialModelMutation<T>({
  items,
  shouldContinue,
  run,
  onProgress,
}: {
  items: readonly T[];
  shouldContinue: () => boolean;
  run: (item: T) => Promise<void>;
  onProgress: (completed: number) => void;
}): Promise<void> {
  onProgress(0);
  for (const [index, item] of items.entries()) {
    if (!shouldContinue()) return;
    await run(item);
    if (shouldContinue()) onProgress(index + 1);
  }
}

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
