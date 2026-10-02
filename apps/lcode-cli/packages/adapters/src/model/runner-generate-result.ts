export function serializeStructuredOutput(result: unknown): string {
  const output = (result as { output?: unknown }).output;
  if (output === undefined) {
    throw new Error("Structured output is unavailable");
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("Structured output is unavailable");
  }
  return serialized;
}

export function waitForGenerateTextOrAbort<T>(
  pending: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("Model request was cancelled."),
      );
    };

    // Provider promise 已创建后，即使取消先赢也必须先观察其 settle；否则 fast-abort
    // 分支会遗留未处理 rejection，并可能直接终止 CLI 进程。
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
