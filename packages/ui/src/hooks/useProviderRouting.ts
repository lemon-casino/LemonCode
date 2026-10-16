import type { ProviderRoutingPolicy } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { useProviderSettingsServiceView } from "./useProviderSettingsView.js";
export function useProviderRouting() {
  const { providerSettingsService } = useServices();
  const read = useProviderSettingsServiceView(providerSettingsService);
  return {
    ...read,
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
