/** 网络 adapter 由 Provider Node 统一维护；保留既有 Services 公共入口。 */
export {
  createHostApiNetworkTransport,
  resolveHostProxyForUrl,
  type HostApiNetworkOptions,
  type HostApiNetworkTransport,
} from "@lcode/provider-node";
