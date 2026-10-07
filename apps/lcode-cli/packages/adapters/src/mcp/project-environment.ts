import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ExecutionEnvOverlay } from "@lcode/contracts";

/** SDK 会再次合并默认环境；用 undefined tombstone 阻止 unset/base:empty 与 Windows 别名复活。 */
export function buildProjectMcpStdioEnv(
  inherited: Record<string, string>,
  overlay: ExecutionEnvOverlay,
  platform: NodeJS.Platform = process.platform,
  sdkDefaults: Record<string, string> = getDefaultEnvironment(),
  configEnv: Record<string, string> = {},
): Record<string, string | undefined> {
  const canonical = (key: string) => (platform === "win32" ? key.toUpperCase() : key);
  const env: Record<string, string | undefined> = {};
  // 先写 SDK 原拼写的 tombstone，再写 canonical 值；Node spawn 忽略 undefined。
  for (const key of Object.keys(sdkDefaults)) env[key] = undefined;
  if (overlay.base !== "empty") {
    for (const [key, value] of Object.entries({ ...sdkDefaults, ...inherited }))
      env[canonical(key)] = value;
  }
  for (const [key, value] of Object.entries(configEnv)) env[canonical(key)] = value;
  for (const [key, value] of Object.entries(overlay.set ?? {})) env[canonical(key)] = value;
  for (const key of overlay.unset ?? []) env[canonical(key)] = undefined;
  return env;
}
