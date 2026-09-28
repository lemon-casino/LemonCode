import {
  lcodeProtocolMethods,
  lcodePluginsReferenceCatalogResultSchema,
  type LCodePluginsReferenceCatalogParams,
} from "@lcode/shared";
import type { LCodeProtocolClient } from "#src/lcode-agent/lcodeProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<LCodeProtocolClient, "request">,
  params: LCodePluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      lcodeProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      lcodePluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      lcodeProtocolMethods.pluginsReferenceCatalog,
      params,
      lcodePluginsReferenceCatalogResultSchema,
    );
  }
}
