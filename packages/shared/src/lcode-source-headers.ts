import { DEFAULT_LCODE_ENDPOINT_ORIGIN } from "./lcodeEndpoint.js";

export const LCODE_SOURCE_HEADERS = {
  "User-Agent": "LCode/unknown",
  "HTTP-Referer": DEFAULT_LCODE_ENDPOINT_ORIGIN,
  "X-Title": "Z Code@electron",
} as const;

export interface BuildLCodeSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeLCodeSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildLCodeSourceHeadersFromContext(
  options: BuildLCodeSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeLCodeSourceHeaderValue(options.appVersion);
  const arch = normalizeLCodeSourceHeaderValue(options.arch);
  const clientLanguage = normalizeLCodeSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeLCodeSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeLCodeSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeLCodeSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_LCODE_ENDPOINT_ORIGIN;
  const osVersion = normalizeLCodeSourceHeaderValue(options.osVersion);
  const platform = normalizeLCodeSourceHeaderValue(options.platform);
  const releaseChannel = normalizeLCodeSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeLCodeSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...LCODE_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `LCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-LCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
