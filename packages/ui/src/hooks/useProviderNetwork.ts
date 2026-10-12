import { useServices } from "./useServices.js";
import { useProviderSettingsServiceView } from "./useProviderSettingsView.js";
import type { ProviderConfigObject } from "@lcode/provider";
import type { ProxyProfile } from "@lcode/shared";
import { useCallback } from "react";

/** 两个设置入口只发字段命令，稀疏 Overlay 的合并由原 Host 写队列负责。 */
export function useProviderNetwork() {
  const { providerSettingsService } = useServices();
  const read = useProviderSettingsServiceView(providerSettingsService);
  return {
    authority: providerSettingsService,
    ...read,
    async save(providerId: string, network: ProviderConfigObject["network"]) {
      const view = await providerSettingsService.setProviderNetwork(providerId, network);
      read.commit(view);
    },
    async importProxies(text: string) {
      read.commit(await providerSettingsService.importProxyProfiles(text));
    },
    async saveProxy(profile: ProxyProfile) {
      read.commit(await providerSettingsService.saveProxyProfile(profile));
    },
    async deleteProxy(id: string) {
      read.commit(await providerSettingsService.deleteProxyProfile(id));
    },
    testProxies: (ids?: readonly string[], operationId?: string) =>
      providerSettingsService.testProxyProfiles(ids, operationId),
    cancelTest: useCallback(
      (operationId: string) => providerSettingsService.cancelProxyTest(operationId),
      [providerSettingsService],
    ),
  };
}
