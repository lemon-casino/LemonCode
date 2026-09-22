import type { ProviderApiKey } from "@zcode/provider";

export type ProviderApiKeyState = ProviderApiKey;

export interface ProviderApiKeyOperationToken {
  readonly scopeKey: string | null;
  readonly generation: number;
}

export interface ProviderApiKeyOperationGuard {
  setScope(scopeKey: string | null): void;
  begin(): ProviderApiKeyOperationToken;
  invalidate(): void;
  isCurrent(token: ProviderApiKeyOperationToken): boolean;
}

export function createProviderApiKeyOperationGuard(
  initialScopeKey: string | null,
): ProviderApiKeyOperationGuard {
  let scopeKey = initialScopeKey;
  let generation = 0;

  return {
    setScope(nextScopeKey) {
      if (nextScopeKey === scopeKey) return;
      scopeKey = nextScopeKey;
      generation += 1;
    },
    begin() {
      generation += 1;
      return { scopeKey, generation };
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(token) {
      return token.scopeKey === scopeKey && token.generation === generation;
    },
  };
}

export function normalizeProviderApiKeys(
  keys: readonly ProviderApiKeyState[],
  legacyApiKey = "",
): ProviderApiKeyState[] {
  const seen = new Set<string>();
  const normalized = keys.flatMap((key) => {
    const apiKey = key.apiKey.trim();
    if (!apiKey || seen.has(apiKey)) return [];
    seen.add(apiKey);
    return [
      {
        id: key.id.trim() || `key-${seen.size}`,
        ...(key.label?.trim() ? { label: key.label.trim() } : {}),
        apiKey,
        enabled: key.enabled !== false,
      },
    ];
  });
  if (normalized.length === 0 && legacyApiKey.trim()) {
    return [{ id: "legacy", label: "API Key 1", apiKey: legacyApiKey.trim(), enabled: true }];
  }
  return normalized;
}

export function selectProviderApiKey(
  keys: readonly ProviderApiKeyState[],
): ProviderApiKeyState | null {
  return keys.find((key) => key.apiKey.trim() && key.enabled !== false) ?? null;
}

export function disableProviderApiKey(
  keys: readonly ProviderApiKeyState[],
  keyId: string,
): ProviderApiKeyState[] {
  return keys.map((key) => (key.id === keyId ? { ...key, enabled: false } : key));
}
