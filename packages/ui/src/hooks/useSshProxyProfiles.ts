import { splitNetworkProxyUrl } from "@lcode/shared";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useProviderSettingsServiceView } from "./useProviderSettingsView.js";

/** SSH 隧道发起于本机 Host；代理来源不能跟随当前远端 workspace 的 ServiceProvider。 */
export function useSshProxyProfiles() {
  const { providerSettingsService } = useBaseWorkspaceServices();
  const { state, reload } = useProviderSettingsServiceView(providerSettingsService);
  return {
    status: state.status,
    reload,
    profiles:
      state.status === "ready"
        ? (state.view.proxyProfiles ?? []).map((profile) => ({
            id: profile.id,
            name: profile.name,
            address: splitNetworkProxyUrl(profile.httpProxy).address,
          }))
        : [],
  };
}
