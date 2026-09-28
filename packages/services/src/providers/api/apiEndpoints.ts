import { buildRuntimeLCodeApiUrl, resolveZaiBusinessBaseUrl } from "@lcode/shared";

export const LCODE_CLIENT_SCENES_URL = buildRuntimeLCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
