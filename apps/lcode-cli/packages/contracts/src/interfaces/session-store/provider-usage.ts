import type { ProviderUsageRequest } from "@lcode/shared";

export interface ProviderUsageQueryInput extends ProviderUsageRequest {
  since: number;
  until: number;
}
