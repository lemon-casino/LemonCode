import { LCODE_UPDATE_SERVICE_ORIGIN, LCODE_VERSION, type LCodeEnv } from "@lcode/shared";

declare const __LCODE_CDN_BASE_URL__: string | undefined;

export interface ResolveRemoteCdnOptions {
  env?: LCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const baseUrl =
    process.env.LCODE_CDN_BASE_URL?.trim() ||
    (typeof __LCODE_CDN_BASE_URL__ === "undefined" ? "" : __LCODE_CDN_BASE_URL__);
  const version = options.version ?? LCODE_VERSION;
  // 修复：安装包已随 GitHub Release 发布，旧默认 CDN 没有远端 manifest。
  // 与桌面更新复用固定 tag 下载入口；显式配置的 CDN 仍保留原有目录规则。
  if (!baseUrl) return [`${LCODE_UPDATE_SERVICE_ORIGIN}/api/v1/releases/download/v${version}`];
  return [`${normalizeBaseUrl(baseUrl)}/lcode/electron/releases/${version}`];
}
