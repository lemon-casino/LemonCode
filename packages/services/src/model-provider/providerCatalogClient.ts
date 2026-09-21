import {
  isApiKeyAccess,
  resolveApiKeyAccessKeys,
  type ProviderConfigObject,
} from "@zcode/provider";

export interface ProviderRemoteModelCatalog {
  readonly models: readonly string[];
}

export interface ProviderApiKeyProbeResult {
  readonly keyId: string;
  readonly status: "valid" | "invalid" | "error";
  readonly message?: string;
}

export interface ProviderCatalogClient {
  listModels(config: ProviderConfigObject): Promise<ProviderRemoteModelCatalog>;
  probeApiKeys(
    config: ProviderConfigObject,
    keyIds?: readonly string[],
  ): Promise<readonly ProviderApiKeyProbeResult[]>;
}

export function createProviderCatalogClient(
  transport: typeof globalThis.fetch = globalThis.fetch,
): ProviderCatalogClient {
  return {
    async listModels(config) {
      const request = resolveCatalogRequest(config);
      const keys = resolveEnabledKeys(config);
      let lastAuthStatus: number | undefined;
      for (const key of keys) {
        const response = await transport(request.url, {
          method: "GET",
          headers: createCatalogHeaders(request.apiType, key.apiKey, config.api?.headers),
        });
        if (response.status === 401 || response.status === 403) {
          lastAuthStatus = response.status;
          await response.body?.cancel().catch(() => undefined);
          continue;
        }
        if (!response.ok) {
          throw new Error(`模型目录请求失败: HTTP ${response.status}`);
        }
        return { models: parseRemoteModelIds(await response.json()) };
      }
      throw new Error(
        lastAuthStatus
          ? `所有已启用 API Key 均鉴权失败: HTTP ${lastAuthStatus}`
          : "没有可用于同步模型的 API Key",
      );
    },

    async probeApiKeys(config, keyIds) {
      const request = resolveCatalogRequest(config);
      const selected = new Set(keyIds?.map((id) => id.trim()).filter(Boolean));
      const keys = resolveApiKeyAccessKeys(requireApiKeyAccess(config)).filter(
        (key) => selected.size === 0 || selected.has(key.id),
      );
      return Promise.all(
        keys.map(async (key): Promise<ProviderApiKeyProbeResult> => {
          try {
            const response = await transport(request.url, {
              method: "GET",
              headers: createCatalogHeaders(request.apiType, key.apiKey, config.api?.headers),
            });
            await response.body?.cancel().catch(() => undefined);
            if (response.ok) return { keyId: key.id, status: "valid" };
            if (response.status === 401 || response.status === 403) {
              return {
                keyId: key.id,
                status: "invalid",
                message: `HTTP ${response.status}`,
              };
            }
            return {
              keyId: key.id,
              status: "error",
              message: `HTTP ${response.status}`,
            };
          } catch (error) {
            return {
              keyId: key.id,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
    },
  };
}

function requireApiKeyAccess(config: ProviderConfigObject) {
  if (!isApiKeyAccess(config.access)) throw new Error("当前供应商不使用 API Key");
  return config.access;
}

function resolveEnabledKeys(config: ProviderConfigObject) {
  return resolveApiKeyAccessKeys(requireApiKeyAccess(config)).filter(
    (key) => key.enabled !== false,
  );
}

function resolveCatalogRequest(config: ProviderConfigObject): {
  readonly apiType: NonNullable<ProviderConfigObject["api"]>["type"];
  readonly url: string;
} {
  const apiType = config.api?.type;
  const baseUrl = config.api?.baseUrl?.trim();
  if (!apiType || !baseUrl) throw new Error("供应商 API 地址或协议不完整");
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  url.pathname =
    apiType === "anthropic-messages" && !path.toLowerCase().endsWith("/v1")
      ? `${path}/v1/models`
      : `${path}/models`;
  return { apiType, url: url.toString() };
}

function createCatalogHeaders(
  apiType: NonNullable<ProviderConfigObject["api"]>["type"],
  apiKey: string,
  configuredHeaders?: Readonly<Record<string, string>> | null,
): Headers {
  const headers = new Headers(configuredHeaders ?? undefined);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (apiType === "anthropic-messages") {
    headers.set("x-api-key", apiKey);
    headers.set("anthropic-version", "2023-06-01");
  }
  return headers;
}

function parseRemoteModelIds(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== "object") throw new Error("模型目录响应格式无效");
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!items) throw new Error("模型目录响应缺少模型列表");
  const ids = items.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    if (!item || typeof item !== "object") return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
  return Object.freeze([...new Set(ids)]);
}
