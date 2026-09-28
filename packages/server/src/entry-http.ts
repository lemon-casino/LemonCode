import { createLocalServices, getAppConfigDir } from "@lcode/services/node";
import {
  materializeBundledLCodeBuiltinProviderConfig,
  readBundledLCodeBuiltinProviderConfig,
} from "./bundledLCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";

async function main(): Promise<void> {
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
