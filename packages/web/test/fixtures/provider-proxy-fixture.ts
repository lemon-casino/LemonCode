import type { ProviderConfigObject } from "../../../provider/src/index.js";
import { parseNetworkProxyLines, type ProxyProfile } from "@lcode/shared";
import type { ProviderSettingsView } from "@lcode/services";

export function createProxyFixtureMethods(
  fixture: { proxyProfiles: ProxyProfile[] },
  getView: () => ProviderSettingsView,
  publish: () => void,
) {
  return {
    async importProxyProfiles(text: string) {
      for (const url of parseNetworkProxyLines(text).urls) {
        if (fixture.proxyProfiles.some((profile) => profile.httpProxy === url)) continue;
        const proxy = new URL(url);
        fixture.proxyProfiles.push({
          id: `proxy-${fixture.proxyProfiles.length + 1}`,
          name: `${proxy.protocol.slice(0, -1).toUpperCase()} ${proxy.host}`,
          httpProxy: url,
        });
      }
      publish();
      return getView();
    },
    async saveProxyProfile(profile: ProxyProfile) {
      fixture.proxyProfiles = fixture.proxyProfiles.map((item) =>
        item.id === profile.id ? profile : item,
      );
      publish();
      return getView();
    },
    async deleteProxyProfile(id: string) {
      fixture.proxyProfiles = fixture.proxyProfiles.filter((item) => item.id !== id);
      publish();
      return getView();
    },
    async cancelProxyTest() {},
    async testProxyProfiles(ids?: readonly string[]) {
      return fixture.proxyProfiles
        .filter((profile) => !ids || ids.includes(profile.id))
        .map((profile) => ({
          profileId: profile.id,
          status: profile.httpProxy.startsWith("socks5:")
            ? ("failed" as const)
            : ("reachable" as const),
          latencyMs: 42,
        }));
    },
  };
}

export function applyProxyFixtureView(
  view: ProviderSettingsView,
  fixture: {
    proxyProfiles: readonly ProxyProfile[];
    proxyNetworks: Record<string, ProviderConfigObject["network"]>;
  },
): ProviderSettingsView {
  return {
    ...view,
    proxyProfiles: fixture.proxyProfiles,
    providers: view.providers.map((provider) => ({
      ...provider,
      effectiveConfig: {
        ...provider.effectiveConfig,
        network: fixture.proxyNetworks[provider.providerId],
      },
      ...(fixture.proxyNetworks[provider.providerId]
        ? {
            personalConfig: {
              ...provider.personalConfig,
              network: fixture.proxyNetworks[provider.providerId],
            },
          }
        : {}),
    })),
  };
}
