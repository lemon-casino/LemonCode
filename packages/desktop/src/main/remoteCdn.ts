import { LCODE_VERSION, type LCodeEnv } from "@lcode/shared";

declare const __LCODE_CDN_BASE_URL__: string | undefined;
const DEFAULT_CDN_BASE_URL = "https://cdn-zcode.z.ai";

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
    (typeof __LCODE_CDN_BASE_URL__ === "undefined" ? "" : __LCODE_CDN_BASE_URL__) ||
    DEFAULT_CDN_BASE_URL;
  return [
    `${normalizeBaseUrl(baseUrl)}/lcode/electron/releases/${options.version ?? LCODE_VERSION}`,
  ];
}
