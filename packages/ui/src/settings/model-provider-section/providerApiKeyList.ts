import type { ProviderApiKey } from "@lcode/provider";

export const API_KEY_PAGE_SIZE = 25;

export function getProviderApiKeyPage(total: number, requestedPage: number) {
  const pages = Math.max(1, Math.ceil(total / API_KEY_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.trunc(requestedPage) || 1));
  const start = (page - 1) * API_KEY_PAGE_SIZE;
  return { page, pages, start, end: Math.min(total, start + API_KEY_PAGE_SIZE), total };
}

export function removeInvalidProviderApiKeys(
  keys: readonly ProviderApiKey[],
  invalidIds: ReadonlySet<string>,
): ProviderApiKey[] {
  return keys.filter((key) => !invalidIds.has(key.id));
}
