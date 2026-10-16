import { useCallback } from "react";
import type { ReadApiKeyRoutingPage, SetApiKeyRoutingMetadata } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { useProviderSettingsServiceView } from "./useProviderSettingsView.js";
import type { ProviderRoutingPolicy } from "@lcode/shared";

export function useProviderRouting() {
  const { providerSettingsService } = useServices();
  const read = useProviderSettingsServiceView(providerSettingsService);
  const readKeys = useCallback(
    (input: ReadApiKeyRoutingPage) => providerSettingsService.readApiKeyRoutingPage(input),
    [providerSettingsService],
  );
  const saveKeys = useCallback(
    async (input: SetApiKeyRoutingMetadata) => {
      const view = await providerSettingsService.setApiKeyRoutingMetadata(input);
      read.commit(view);
      return view.revision;
    },
    [providerSettingsService, read.commit],
  );
  return {
    ...read,
    supportsBatchMetadata:
      typeof providerSettingsService.readApiKeyRoutingPage === "function" &&
      typeof providerSettingsService.setApiKeyRoutingMetadata === "function",
    readKeys,
    saveKeys,
    async save(
      providerId: string,
      expectedRevision: number,
      routing: ProviderRoutingPolicy | null,
    ) {
      const view = await providerSettingsService.setProviderRouting({
        providerId,
        expectedRevision,
        routing,
      });
      read.commit(view);
      return view.revision;
    },
  };
}
