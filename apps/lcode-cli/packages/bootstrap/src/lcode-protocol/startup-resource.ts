import type { Logger } from "@lcode/contracts";

/** 关闭信号不能等卡住的初始化 Promise；迟到资源由创建边界负责释放。 */
export async function acquireProtocolStartupResource<T>(options: {
  create: () => Promise<T>;
  signal?: AbortSignal;
  disposeLate?: (resource: T) => unknown | Promise<unknown>;
  logger: Logger;
}): Promise<T> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!signal) return options.create();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return options.create();
      })
      .then(
        async (resource) => {
          signal.removeEventListener("abort", abort);
          if (!signal.aborted) return resolve(resource);
          try {
            await options.disposeLate?.(resource);
          } catch (error) {
            options.logger.warn("Late protocol startup resource cleanup failed", {
              errorType: error instanceof Error ? error.name : typeof error,
              event: "lcode_protocol.startup.late_cleanup.failed",
            });
          }
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}
