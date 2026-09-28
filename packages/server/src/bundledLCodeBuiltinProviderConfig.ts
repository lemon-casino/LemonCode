import { materializeLCodeBuiltinProviderConfig } from "@lcode/services/node";

declare const __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

interface MaterializeBundledLCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 LCode Built-in Provider Config。 */
export function readBundledLCodeBuiltinProviderConfig(): string {
  if (typeof __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 LCode Built-in Provider Config");
  }
  return __LCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 LCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledLCodeBuiltinProviderConfig(
  options: MaterializeBundledLCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeLCodeBuiltinProviderConfig(options);
}
