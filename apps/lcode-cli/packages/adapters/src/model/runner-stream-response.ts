import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import type { AiSdkStreamTextResult } from "./runner-runtime.js";

export async function resolveStreamResponseHeaders(
  result: AiSdkStreamTextResult,
): Promise<Record<string, string>> {
  try {
    const response = await (result as unknown as { response?: Promise<unknown> }).response;
    return sanitizeModelNetworkHeaders((response as { headers?: unknown } | undefined)?.headers);
  } catch {
    return {};
  }
}
