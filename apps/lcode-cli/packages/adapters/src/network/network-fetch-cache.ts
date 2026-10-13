import type { ManagedNetworkFetch } from "./proxy-fetch.js";

/** 仅缓存连接资源；旧 Model 的闭包保留冻结策略，被淘汰后按原策略重建。 */
export class NetworkFetchCache {
  private readonly entries = new Map<string, ManagedNetworkFetch>();
  private readonly retiring = new Set<Promise<void>>();
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
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      let fetch = this.entries.get(key);
      if (!fetch) fetch = create(() => this.trimIdle());
      this.entries.delete(key);
      this.entries.set(key, fetch);
      // 底层同步登记请求租约后才淘汰；不能把刚开始发送的请求误认成 idle。
      const result = fetch(request);
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
    this.closing = Promise.all(this.retiring).then(() => undefined);
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
    this.retiring.add(closing);
    void closing.then(
      () => this.retiring.delete(closing),
      () => this.retiring.delete(closing),
    );
  }
}
