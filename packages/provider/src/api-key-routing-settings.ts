import type { ProviderApiKey } from "./config/provider-config.js";
import {
  apiKeyRoutingMetadataSchema,
  type ApiKeyRoutingPage,
  type SetApiKeyRoutingMetadata,
} from "@lcode/shared/provider-routing";

const summaries = new WeakMap<
  readonly ProviderApiKey[],
  { enabled: number; sharedPools: number; cacheGroups: number; duplicates: Set<string> }
>();
function summary(keys: readonly ProviderApiKey[]) {
  let value = summaries.get(keys);
  if (value) return value;
  const pools = new Set<string>(),
    caches = new Set<string>(),
    seen = new Set<string>(),
    duplicates = new Set<string>();
  let enabled = 0;
  for (const key of keys) {
    if (key.enabled !== false) enabled++;
    if (key.routing?.quotaPoolId) pools.add(key.routing.quotaPoolId);
    if (key.routing?.cacheGroupId) caches.add(key.routing.cacheGroupId);
    if (seen.has(key.id.trim())) duplicates.add(key.id.trim());
    seen.add(key.id.trim());
  }
  value = { enabled, sharedPools: pools.size, cacheGroups: caches.size, duplicates };
  summaries.set(keys, value);
  return value;
}
export function readApiKeyRoutingRows(
  keys: readonly ProviderApiKey[],
  offset: number,
  limit: number,
  revision: number,
): ApiKeyRoutingPage {
  const { duplicates, ...counts } = summary(keys);
  return {
    source: "configuration",
    revision,
    total: keys.length,
    offset,
    nextOffset: offset + limit < keys.length ? offset + limit : undefined,
    summary: counts,
    rows: keys.slice(offset, offset + limit).map((key) => ({
      id: key.id,
      enabled: key.enabled !== false,
      routing: key.routing,
      issues: [
        ...(duplicates.has(key.id.trim()) ? ["duplicate-id"] : []),
        ...(key.routing?.cacheGroupId && !key.routing.cacheTtlMs ? ["cache-ttl-missing"] : []),
        ...(key.routing?.cacheTtlMs && !key.routing.cacheGroupId ? ["cache-group-missing"] : []),
      ],
    })),
  };
}
export function patchApiKeyRoutingRows(
  keys: readonly ProviderApiKey[],
  input: Pick<SetApiKeyRoutingMetadata, "target" | "patch">,
): readonly ProviderApiKey[] {
  if (summary(keys).duplicates.size) throw new Error("Duplicate API key IDs");
  const selected = input.target.type === "ids" ? new Set(input.target.keyIds) : undefined;
  let matched = 0;
  const next = keys.map((key) => {
    if (selected && !selected.has(key.id)) return key;
    matched++;
    const { routing: _routing, ...rest } = key;
    const routing = { ...key.routing } as Record<string, unknown>;
    if (input.patch === null) return rest;
    for (const [field, value] of Object.entries(input.patch)) {
      if (value === null) delete routing[field];
      else if (value !== undefined) routing[field] = value;
    }
    return {
      ...rest,
      ...(Object.keys(routing).length
        ? { routing: apiKeyRoutingMetadataSchema.parse(routing) }
        : {}),
    };
  });
  if (selected && matched !== selected.size) throw new Error("Unknown API key ID");
  return next;
}
/** 旧凭据表单不能覆盖独立保存的路由字段；更换凭据或新增行仍由原入口处理。 */
export function preserveApiKeyRoutingRows(
  incoming: readonly ProviderApiKey[],
  current: readonly ProviderApiKey[],
): readonly ProviderApiKey[] {
  const byId = new Map(current.map((key) => [key.id, key]));
  return incoming.map((key) => {
    const existing = byId.get(key.id);
    if (!existing || existing.apiKey.trim() !== key.apiKey.trim()) return key;
    const { routing: _routing, ...rest } = key;
    return { ...rest, ...(existing.routing ? { routing: existing.routing } : {}) };
  });
}
