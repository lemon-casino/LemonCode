import type { AuthDriver } from "@lcode/provider-node";

/** 原账号服务的关闭进度；成功的 driver 不重复关闭，失败的原句柄继续保留。 */
export class ProviderAccountDriverCleanup {
  private readonly completed = new Set<AuthDriver>();
  private readonly pending = new Map<AuthDriver, Promise<void>>();

  async close(drivers: Iterable<AuthDriver>): Promise<void> {
    const closing = [...new Set(drivers)]
      .filter((driver) => !this.completed.has(driver))
      .map((driver) => {
        let operation = this.pending.get(driver);
        if (!operation) {
          operation = Promise.resolve()
            .then(() => driver.dispose?.())
            .then(() => {
              this.completed.add(driver);
            })
            .finally(() => {
              this.pending.delete(driver);
            });
          this.pending.set(driver, operation);
        }
        return operation;
      });
    const results = await Promise.allSettled(closing);
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "Provider account resource cleanup failed");
  }
}
