import { arch as readOsArch, release as readOsRelease } from "node:os";

const PRINTABLE_HEADER_VALUE_PATTERN = /^[\x20-\x7e]+$/;

export function createRuntimePlatformHeaders(): Record<string, string> {
  const platform = normalizePrintableHeaderValue(process.platform);
  const architecture = normalizePrintableHeaderValue(readOsArch());
  const osVersion = normalizePrintableHeaderValue(readOsRelease());
  return {
    ...(platform && architecture ? { "X-Platform": `${platform}-${architecture}` } : {}),
    "X-Os-Category": normalizeOsCategory(process.platform),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
  };
}

export function normalizePrintableHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PRINTABLE_HEADER_VALUE_PATTERN.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
