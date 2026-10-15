import type { ManagedNetworkFetch } from "./proxy-fetch.js";

/** 仅缓存连接资源；旧 Model 的闭包保留冻结策略，被淘汰后按原策略重建。 */
export class NetworkFetchCache {
  private readonly entries = new Map<string, ManagedNetworkFetch>();
  private readonly retiring = new Map<ManagedNetworkFetch, Promise<void>>();
  private readonly failed = new Set<ManagedNetworkFetch>();
  private retryCleanup = false;
  private disposed = false;
  private closing?: Promise<void>;

  constructor(private readonly maxIdle = 32) {}

  fetchFor(
    key: string,
    create: (onIdle: () => void) => ManagedNetworkFetch,
  ): typeof globalThis.fetch {
    return async (input, init) => {
      if (this.disposed)
        throw new DOMException("Model network resources have been disposed", "AbortError");
      // 只校验原 signal，Request 构造与 body 由唯一 transport 持有；额外包装会隐藏上传源关闭。
      const signal =
        init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
      signal?.throwIfAborted();
      let fetch = this.entries.get(key);
      if (!fetch) fetch = create(() => this.trimIdle());
      this.entries.delete(key);
      this.entries.set(key, fetch);
      // 底层同步登记请求租约后才淘汰；不能把刚开始发送的请求误认成 idle。
      const result = fetch(input, init);
      this.trimIdle();
      return result;
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fetch of this.entries.values()) this.retire(fetch);
    this.entries.clear();
  }

  disposeAndWait(): Promise<void> {
    if (this.closing) return this.closing;
    this.dispose();
    if (this.retryCleanup) {
      this.retryCleanup = false;
      for (const fetch of this.failed) this.retire(fetch);
    }
    this.closing = Promise.allSettled(this.retiring.values()).then((results) => {
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Model network cleanup failed");
    });
    void this.closing.catch(() => {
      this.retryCleanup = true;
      this.closing = undefined;
    });
    return this.closing;
  }

  private trimIdle(): void {
    if (this.disposed) return;
    let idle = 0;
    for (const fetch of this.entries.values()) if (fetch.activeRequestCount === 0) idle++;
    for (const [key, fetch] of this.entries) {
      if (idle <= this.maxIdle) break;
      if (fetch.activeRequestCount !== 0) continue;
      this.entries.delete(key);
      idle--;
      this.retire(fetch);
    }
  }

  private retire(fetch: ManagedNetworkFetch): void {
    fetch.dispose();
    const closing = fetch.disposeAndWait();
    this.retiring.set(fetch, closing);
    void closing.then(
      () => {
        this.retiring.delete(fetch);
        this.failed.delete(fetch);
      },
      () => {
        this.failed.add(fetch);
      },
    );
  }
}
