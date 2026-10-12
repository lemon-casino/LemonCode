import {
  createHostApiNetworkTransport,
  resolveProviderNetworkOptions,
  type HostApiNetworkOptions,
} from "@lcode/provider-node";
import type { ProxyConnectivityResult, ProxyProfile } from "@lcode/shared";

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
  return {
    async test(
      profiles: readonly ProxyProfile[],
      signal?: AbortSignal,
    ): Promise<readonly ProxyConnectivityResult[]> {
      lifetime.signal.throwIfAborted();
      const results: ProxyConnectivityResult[] = [];
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(PROXY_TEST_CONCURRENCY, profiles.length) },
        async () => {
          for (;;) {
            if (signal?.aborted) return;
            const profile = profiles[cursor++];
            if (!profile) return;
            const start = performance.now();
            const transport = createHostApiNetworkTransport(async () =>
              resolveProviderNetworkOptions(
                { mode: "custom", httpProxy: profile.httpProxy, caCertPath: profile.caCertPath },
                await resolveDefaults(),
              ),
            );
            transports.add(transport);
            let status: ProxyConnectivityResult["status"] = "failed";
            try {
              const response = await (testFetch ?? transport.fetch)(PROXY_TEST_URL, {
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
              lifetime.signal.throwIfAborted();
              if (signal?.aborted) return;
            } finally {
              transports.delete(transport);
              transport.dispose();
            }
            results.push({
              profileId: profile.id,
              status,
              latencyMs: Math.round(performance.now() - start),
            });
          }
        },
      );
      await Promise.all(workers);
      return profiles.flatMap((profile) => {
        const result = results.find((item) => item.profileId === profile.id);
        return result ? [result] : [];
      });
    },
    dispose() {
      lifetime.abort();
      for (const transport of transports) transport.dispose();
    },
  };
}
