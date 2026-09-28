export async function mapWithFixedConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<TResult>,
): Promise<Array<PromiseSettledResult<TResult>>> {
  const results: Array<PromiseSettledResult<TResult>> = [];
  results.length = values.length;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index]!;
      try {
        results[index] = { status: "fulfilled", value: await mapper(value) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
