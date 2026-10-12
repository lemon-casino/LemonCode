export * from "./network-transport.js";
import type { HostApiNetworkOptions } from "./network-transport.js";
import { resolveProviderNetworkConfig } from "@lcode/provider";
import type { ProxyProfile } from "@lcode/shared/network-proxy";

export function resolveProviderNetworkOptions(
  input: import("@lcode/provider").ProviderConfigObject["network"],
  defaults: HostApiNetworkOptions,
  profiles?: readonly ProxyProfile[],
): HostApiNetworkOptions {
  const network = resolveProviderNetworkConfig(input, profiles);
  if (!network || network.mode === "default") return defaults;
  if (network.mode === "direct") return { caCertPath: defaults.caCertPath, forceDirect: true };
  return {
    httpProxy: network.httpProxy,
    noProxy: network.noProxy,
    caCertPath: network.caCertPath || defaults.caCertPath,
    forceDirect: true,
  };
}
