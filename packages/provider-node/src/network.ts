/** CLI/Host 共用窄公开入口，不加载 OAuth/插件实现。每个创建者拥有独立资源。 */
export {
  createHostApiNetworkTransport as createProviderNetworkTransport,
  resolveHostProxyForUrl,
  type HostApiNetworkOptions as ProviderNetworkOptions,
  type HostApiNetworkTransport as ProviderNetworkTransport,
} from "./network-transport.js";
