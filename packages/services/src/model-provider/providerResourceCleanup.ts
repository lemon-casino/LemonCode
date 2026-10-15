interface Entry {
  readonly close: () => unknown;
  readonly pending: Promise<void>;
  failed: boolean;
  error?: unknown;
}

/** 每个 Provider owner 的物理退出进度；保留失败句柄，不保存业务队列或凭据。 */
export class ProviderResourceCleanup {
  private readonly entries = new Map<object, Entry>();

  retain(key: object, close: () => unknown): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) return existing.pending;
    const deferred = Promise.withResolvers<void>();
    const entry: Entry = { close, pending: deferred.promise, failed: false };
    this.entries.set(key, entry);
    // 必须同步进入 close 封闭下层准入；一个同步异常不能阻止其它资源开始关闭。
    try {
      Promise.resolve(close()).then(() => deferred.resolve(), deferred.reject);
    } catch (error) {
      deferred.reject(error);
    }
    void entry.pending.then(
      () => {
        this.entries.delete(key);
      },
      (error: unknown) => {
        entry.failed = true;
        entry.error = error;
      },
    );
    return entry.pending;
  }

  retryFailed(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.failed) continue;
      this.entries.delete(key);
      void this.retain(key, entry.close);
    }
  }

  async drain(): Promise<void> {
    while ([...this.entries.values()].some((entry) => !entry.failed))
      await Promise.allSettled([...this.entries.values()].map((entry) => entry.pending));
    const failures = [...this.entries.values()].map((entry) => entry.error);
    if (failures.length) throw new AggregateError(failures, "Provider resource cleanup failed");
  }
}
