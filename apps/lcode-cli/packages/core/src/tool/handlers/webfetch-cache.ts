import { CACHE_MAX_BYTES, CACHE_TTL_MS } from "./webfetch-constants.js";
import type { CachedFetchContent } from "./webfetch-types.js";

interface CacheEntry extends CachedFetchContent {
  expiresAt: number;
}

const fetchCache = new Map<string, CacheEntry>();
let cacheBytes = 0;

export function clearWebFetchCacheForTests(): void {
  fetchCache.clear();
  cacheBytes = 0;
}

export function getWebFetchCache(key: string): CachedFetchContent | undefined {
  const entry = fetchCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
    return undefined;
  }
  fetchCache.delete(key);
  fetchCache.set(key, entry);
  return entry;
}

export function putWebFetchCache(key: string, value: CachedFetchContent): void {
  if (value.sizeBytes > CACHE_MAX_BYTES) return;

  const previous = fetchCache.get(key);
  if (previous) {
    cacheBytes -= previous.sizeBytes;
  }

  fetchCache.set(key, {
    ...value,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  cacheBytes += value.sizeBytes;
  pruneCache();
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of fetchCache) {
    if (entry.expiresAt > now) continue;
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
  }

  for (const [key, entry] of fetchCache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    fetchCache.delete(key);
    cacheBytes -= entry.sizeBytes;
  }
}
