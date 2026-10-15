interface CleanupEntry {
  run: () => Promise<unknown>;
  done: Promise<void>;
  failed: boolean;
  error?: unknown;
}

/** 原网络 owner 的物理清理账本；业务取消不代表 socket/body 已经关闭。 */
export class NetworkCleanup {
  private readonly entries = new Map<object, CleanupEntry>();

  retain(key: object, run: () => Promise<unknown>): void {
    if (this.entries.has(key)) return;
    const entry: CleanupEntry = { run, done: Promise.resolve(), failed: false };
    this.entries.set(key, entry);
    entry.done = Promise.resolve()
      .then(run)
      .then(
        () => {
          this.entries.delete(key);
        },
        (error: unknown) => {
          entry.failed = true;
          entry.error = error;
        },
      );
  }

  retryFailed(): void {
    for (const [key, entry] of this.entries) {
      if (!entry.failed) continue;
      this.entries.delete(key);
      this.retain(key, entry.run);
    }
  }

  async drain(): Promise<void> {
    // 初始化/迟到 headers 可能继续登记原资源，不能只等待第一次快照。
    while ([...this.entries.values()].some((entry) => !entry.failed)) {
      await Promise.all([...this.entries.values()].map((entry) => entry.done));
    }
    const errors = [...this.entries.values()].map((entry) => entry.error);
    if (errors.length)
      throw new AggregateError(
        errors,
        `Network cleanup failed: ${errors.map((error) => (error instanceof Error ? error.message : "unknown failure")).join("; ")}`,
      );
  }
}
