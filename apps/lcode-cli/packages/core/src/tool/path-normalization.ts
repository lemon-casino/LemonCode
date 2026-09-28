// ============================================================
// Tool Path Normalization Helpers
// ============================================================

import path, { normalize } from "node:path";
import { platform as currentPlatform } from "node:process";

export type ToolPathPlatform = NodeJS.Platform;
export type ToolPathApi = typeof path.posix | typeof path.win32;

export function getToolPathApi(platform: ToolPathPlatform): ToolPathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizeToolPathForComparison(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  const normalized =
    platform === "win32" ? normalizeWindowsToolPath(filePath) : normalize(filePath);
  return normalized.normalize("NFC");
}

function normalizeWindowsToolPath(filePath: string): string {
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(path.win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // Read/Edit/Write 和 Bash cwd 都会收到 Git Bash 风格的 /c/... 路径；
  // 统一转换到 drive-letter 形式，避免各工具重复实现 Windows path 兼容逻辑。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
