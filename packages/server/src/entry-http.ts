import { migrateHomeBrandDataRootSync } from "@lcode/shared/node";
import { createLocalServices, getDataBaseDir, getAppConfigDir } from "@lcode/services/node";
import {
  materializeBundledLCodeBuiltinProviderConfig,
  readBundledLCodeBuiltinProviderConfig,
} from "./bundledLCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
  // 品牌迁移（复制式、幂等）先于 config/任务索引访问：~/.zcode → ~/.lcode。
  migrateHomeBrandDataRootSync(getDataBaseDir());
  const lcodeBuiltinProviderConfigFilePath = await materializeBundledLCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledLCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["LCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["LCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["LCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    lcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[lcode-server:http] startup failed", error);
  process.exitCode = 1;
});
