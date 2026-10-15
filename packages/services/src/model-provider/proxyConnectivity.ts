import {
  createHostApiNetworkTransport,
  resolveProviderNetworkOptions,
  type HostApiNetworkOptions,
} from "@lcode/provider-node";
import type { ProxyConnectivityResult, ProxyProfile } from "@lcode/shared";
import { ProviderResourceCleanup } from "./providerResourceCleanup.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const PROXY_TEST_URL = "https://example.com/";
const PROXY_TEST_TIMEOUT_MS = 10_000;
const PROXY_TEST_CONCURRENCY = 3;

/** 当前 Host 拥有检测；结果只描述此次代理认证/TLS/HTTP 请求，不宣称供应商可用。 */
export function createProxyConnectivityTester(
  resolveDefaults: () => Promise<HostApiNetworkOptions>,
  testFetch?: typeof fetch,
) {
  const lifetime = new AbortController();
  const transports = new Set<ReturnType<typeof createHostApiNetworkTransport>>();
  const batches = new Set<Promise<unknown>>(),
    cleanup = new ProviderResourceCleanup();
  let closing: Promise<void> | undefined,
    retryClose = false;
  const retire = (transport: ReturnType<typeof createHostApiNetworkTransport>) =>
    cleanup.retain(transport, () => transport.disposeAndWait());
  const dispose = () => {
    lifetime.abort();
    for (const transport of transports) void retire(transport);
  };
  const disposeAndWait = () => {
    if (closing) return closing;
    if (retryClose) {
      cleanup.retryFailed();
      retryClose = false;
    }
    dispose();
    closing = (async () => {
      await Promise.allSettled(batches);
      await cleanup.drain();
    })();
    void closing.catch(() => {
      retryClose = true;
      closing = undefined;
    });
    return closing;
  };
  const run = async (
    profiles: readonly ProxyProfile[],
    signal?: AbortSignal,
  ): Promise<readonly ProxyConnectivityResult[]> => {
    lifetime.signal.throwIfAborted();
    const results: ProxyConnectivityResult[] = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(PROXY_TEST_CONCURRENCY, profiles.length) },
      async () => {
        for (;;) {
          if (lifetime.signal.aborted || signal?.aborted) return;
          const profile = profiles[cursor++];
          if (!profile) return;
          const start = performance.now();
          const transport = createHostApiNetworkTransport(
            async () =>
              resolveProviderNetworkOptions(
                { mode: "custom", httpProxy: profile.httpProxy, caCertPath: profile.caCertPath },
                await resolveDefaults(),
              ),
            { fetch: testFetch },
          );
          transports.add(transport);
          let status: ProxyConnectivityResult["status"] = "failed";
          try {
            const response = await transport.fetch(PROXY_TEST_URL, {
              method: "GET",
              redirect: "error",
              signal: AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(PROXY_TEST_TIMEOUT_MS),
                ...(signal ? [signal] : []),
              ]),
            });
            status = response.ok ? "reachable" : "failed";
            await response.body?.cancel();
          } catch {
            if (lifetime.signal.aborted || signal?.aborted) return;
          } finally {
            // 退出前仍由原 owner 保有迟到 body/dispatcher，不能提前从活动集合删除。
            await retire(transport);
            transports.delete(transport);
          }
          if (lifetime.signal.aborted || signal?.aborted) return;
          results.push({
            profileId: profile.id,
            status,
            latencyMs: Math.round(performance.now() - start),
          });
        }
      },
    );
    const outcomes = await Promise.allSettled(workers);
    lifetime.signal.throwIfAborted();
    if (signal?.aborted) return [];
    const failures = outcomes
      .filter((item) => item.status === "rejected")
      .map((item) => item.reason);
    if (failures.length) throw new AggregateError(failures, "Proxy probe cleanup failed");
    return profiles.flatMap((profile) => {
      const result = results.find((item) => item.profileId === profile.id);
      return result ? [result] : [];
    });
  };
  return {
    test(profiles: readonly ProxyProfile[], signal?: AbortSignal) {
      const batch = run(profiles, signal);
      batches.add(batch);
      const settled = () => {
        batches.delete(batch);
      };
      void batch.then(settled, settled);
      return batch;
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      void disposeAndWait().catch(() => {
        createServiceLogger("proxy-connectivity").warn(
          "Proxy cleanup failed; original resources retained",
        );
      });
    },
    disposeAndWait,
  };
}
