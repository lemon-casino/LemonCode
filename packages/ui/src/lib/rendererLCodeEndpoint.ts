import {
  buildRuntimeLCodeEndpointUrls,
  LCODE_ENV,
  type RuntimeLCodeEndpointEnv,
} from "@lcode/shared";

interface RendererImportMetaEnv {
  VITE_LCODE_BASE_URL?: string;
  VITE_LCODE_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

function createRendererLCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeLCodeEndpointEnv {
  return {
    LCODE_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看 LCODE_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    LCODE_BASE_URL: env.VITE_LCODE_BASE_URL,
    LCODE_ENDPOINT_ORIGIN: env.VITE_LCODE_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_LCODE_ENDPOINT_URLS = buildRuntimeLCodeEndpointUrls(
  createRendererLCodeEndpointEnv(),
);
