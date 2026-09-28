export const LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "LCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const LCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "LCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const LCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "LCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly lcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.lcodeBuiltinFilePath,
    [LCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const lcodeBuiltinFilePath = env[LCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[LCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!lcodeBuiltinFilePath && !personalFilePath) return null;
  if (!lcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("LCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ lcodeBuiltinFilePath, personalFilePath });
}
