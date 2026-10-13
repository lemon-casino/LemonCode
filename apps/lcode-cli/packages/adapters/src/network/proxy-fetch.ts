import {
  createProviderNetworkTransport,
  type ProviderNetworkTransport,
} from "@lcode/provider-node/network";
import { LCODE_HTTP_PROXY_ENV_KEY, LCODE_NO_PROXY_ENV_KEY } from "@lcode/shared";
import { resolveTlsCaCertFile } from "./http-config.js";

export interface NetworkProxyFetchOptions {
  http2?: "disabled" | "negotiate";
  onIdle?: () => void;
  forceDirect?: boolean;
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  httpProxy?: string;
  noProxy?: string;
}

export type ManagedNetworkFetch = typeof globalThis.fetch &
  Pick<ProviderNetworkTransport, "dispose" | "disposeAndWait" | "activeRequestCount">;

/** CLI 只派生显式出口参数；连接、CA、取消与关闭复用公共 Node 网络内核。 */
export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): ManagedNetworkFetch {
  const transport = createProviderNetworkTransport(
    async () => ({
      forceDirect: true,
      http2: options.http2,
      proxyTunnel: false,
      httpProxy:
        options.httpProxy ??
        (options.forceDirect ? undefined : options.env?.[LCODE_HTTP_PROXY_ENV_KEY]),
      noProxy:
        options.noProxy ??
        (options.forceDirect ? undefined : options.env?.[LCODE_NO_PROXY_ENV_KEY]),
      caCertPath: resolveTlsCaCertFile(options),
    }),
    { fetch: options.fetch, onIdle: options.onIdle },
  );
  const fetch = transport.fetch as ManagedNetworkFetch;
  fetch.dispose = () => transport.dispose();
  fetch.disposeAndWait = () => transport.disposeAndWait();
  Object.defineProperty(fetch, "activeRequestCount", { get: () => transport.activeRequestCount });
  return fetch;
}
