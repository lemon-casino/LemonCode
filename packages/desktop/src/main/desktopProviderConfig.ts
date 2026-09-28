import { app } from "electron";
import { join } from "node:path";

export function resolveLCodeBuiltinProviderConfigFilePath(options?: {
  readonly appPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
}): string {
  const explicitPath = (options?.env ?? process.env)["LCODE_BUILTIN_PROVIDER_CONFIG_FILE"]?.trim();
  if (explicitPath) return explicitPath;
  if (options?.isPackaged ?? app.isPackaged) {
    return join(
      options?.resourcesPath ?? process.resourcesPath,
      "config/provider/lcode-builtin.json",
    );
  }
  // 开发态与打包共用唯一线上配置源。
  const filename = "lcode-builtin.json";
  return join(options?.appPath ?? app.getAppPath(), "../../config/provider", filename);
}
