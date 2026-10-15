/** Host 的等待式退出必须启动全部独立网络 owner，不能因其它资源失败跳过它们。 */
export async function drainProviderServiceResources(
  resources: {
    runtime?: { disposeAndWait(): Promise<void> };
    hostNetwork?: { disposeAndWait(): Promise<void> };
  },
  remaining: () => Promise<void>,
): Promise<void> {
  const begin = (close: () => unknown) => {
    try {
      return Promise.resolve(close());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const results = await Promise.allSettled([
    begin(() => resources.runtime?.disposeAndWait()),
    begin(() => resources.hostNetwork?.disposeAndWait()),
    begin(remaining),
  ]);
  const failures = results.filter((item) => item.status === "rejected").map((item) => item.reason);
  if (failures.length) throw new AggregateError(failures, "Host service resource cleanup failed");
}
