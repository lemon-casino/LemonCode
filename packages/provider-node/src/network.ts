/** CLI/Host 共用窄公开入口，不加载 OAuth/插件实现。每个创建者拥有独立资源。 */
import undiciPackage from "undici/package.json" with { type: "json" };
export const PROVIDER_NETWORK_BACKEND_VERSION: string = undiciPackage.version;
export { getProviderNetworkDiagnostics } from "./network-diagnostics.js";
export { connectNetworkProxySocket, type NetworkProxySocketOptions } from "./proxy-socket.js";
export {
  createHostApiNetworkTransport as createProviderNetworkTransport,
  resolveHostProxyForUrl,
  type HostApiNetworkOptions as ProviderNetworkOptions,
  type HostApiNetworkTransport as ProviderNetworkTransport,
} from "./network-transport.js";
