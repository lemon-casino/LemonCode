import type { AuthDriver } from "@lcode/provider-node";

/** 原账号服务的关闭进度；成功的 driver 不重复关闭，失败的原句柄继续保留。 */
export class ProviderAccountDriverCleanup {
  private readonly completed = new Set<AuthDriver>();
  private readonly pending = new Map<AuthDriver, Promise<void>>();
  private readonly failed = new Map<AuthDriver, unknown>();
  private readonly constructing = new Set<Promise<unknown>>();

  constructDriver<T>(options: {
    create(): Promise<AuthDriver>;
    closed(): boolean;
    validate?(): Promise<boolean>;
    publish(driver: AuthDriver): T;
  }): Promise<T> {
    return this.construct(async () => {
      if (options.closed()) throw new Error("Provider account service closed");
      const driver = await options.create();
      try {
        const valid = options.validate ? await options.validate() : true;
        // 必须先完成异步校验再读 owner 状态，防止跨 await 发布退休后的资源。
        if (options.closed() || !valid) throw new Error("Provider account service closed");
        return options.publish(driver);
      } catch (error) {
        await this.retire(driver);
        throw error;
      }
    });
  }

  construct<T>(operation: () => Promise<T>): Promise<T> {
    const construction = Promise.resolve().then(operation);
    this.constructing.add(construction);
    const settled = () => {
      this.constructing.delete(construction);
    };
    void construction.then(settled, settled);
    return construction;
  }

  retire(driver: AuthDriver): Promise<void> {
    if (this.completed.has(driver)) return Promise.resolve();
    let operation = this.pending.get(driver);
    if (!operation) {
      operation = Promise.resolve()
        .then(() => driver.dispose?.())
        .then(
          () => {
            this.completed.add(driver);
            this.failed.delete(driver);
          },
          (error: unknown) => {
            this.failed.set(driver, error);
            throw error;
          },
        )
        .finally(() => {
          this.pending.delete(driver);
        });
      this.pending.set(driver, operation);
    }
    return operation;
  }

  async close(drivers: Iterable<AuthDriver>): Promise<void> {
    for (const driver of new Set([...drivers, ...this.failed.keys()]))
      void this.retire(driver).catch(() => {});
    // factory / 凭据读取还在 await 时，driver 尚未进入缓存；不能只等第一次资源快照。
    while (this.constructing.size || this.pending.size)
      await Promise.allSettled([...this.constructing, ...this.pending.values()]);
    const errors = [...this.failed.values()];
    if (errors.length) throw new AggregateError(errors, "Provider account resource cleanup failed");
  }
}
