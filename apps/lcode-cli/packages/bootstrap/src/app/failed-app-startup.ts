type Cleanup = () => void | Promise<void>;
const causes = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors : [error];

/** 未发布候选的资源句柄；原错误与重试能力一起交给宿主，不伪装成已分配的 App。 */
export class AppStartupCleanupError extends AggregateError {
  readonly retryCleanup: () => Promise<void>;
  constructor(
    readonly sessionId: string,
    original: unknown,
    cleanupError: unknown,
    retry: () => Promise<void>,
  ) {
    super([original, ...causes(cleanupError)], "App startup failed with unfinished cleanup", {
      cause: original,
    });
    this.name = "AppStartupCleanupError";
    this.retryCleanup = async () => {
      try {
        await retry();
      } catch (error) {
        throw new AggregateError(
          [original, ...causes(error)],
          "App startup cleanup remains pending",
          { cause: original },
        );
      }
    };
  }
}

export async function failAppStartup(input: {
  sessionId: string;
  error: unknown;
  resources: ReadonlyArray<Cleanup | undefined>;
  retire?: Cleanup;
  closeStore?: Cleanup;
}): Promise<never> {
  const progress = new Map<Cleanup, Promise<void>>();
  const close = (cleanup: Cleanup) => {
    const existing = progress.get(cleanup);
    if (existing) return existing;
    const work = Promise.resolve()
      .then(cleanup)
      .catch((error: unknown) => {
        progress.delete(cleanup);
        throw error;
      });
    progress.set(cleanup, work);
    return work;
  };
  const retry = async () => {
    const results = await Promise.allSettled(
      input.resources.flatMap((resource) => (resource ? [close(resource)] : [])),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Startup resource cleanup failed");
    // 没有发布不等于资源已释放；成功清理后才能退休原 token，退休后才能关自建 store。
    if (input.retire) await close(input.retire);
    if (input.closeStore) await close(input.closeStore);
  };
  try {
    await retry();
  } catch (error) {
    throw new AppStartupCleanupError(input.sessionId, input.error, error, retry);
  }
  throw input.error;
}
