import type { ProxyProfile } from "@lcode/shared/network-proxy";
import type { ProviderConfigObject } from "./config/index.js";

/** 列表引用只在出口派生；配置文件仍保留唯一 profileId，不复制地址。 */
export function resolveProviderNetworkConfig(
  network: ProviderConfigObject["network"],
  profiles: readonly ProxyProfile[] = [],
): Exclude<ProviderConfigObject["network"], { mode: "profile" }> {
  if (network?.mode !== "profile") return network;
  const profile = profiles.find((item) => item.id === network.profileId);
  if (!profile) throw new Error("Proxy profile does not exist");
  return {
    mode: "custom",
    httpProxy: profile.httpProxy,
    noProxy: profile.noProxy,
    caCertPath: profile.caCertPath,
  };
}
