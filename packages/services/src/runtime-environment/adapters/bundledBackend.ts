import { dirname, isAbsolute, join, resolve } from "node:path";

export interface BundledBackendLocation {
  platform?: NodeJS.Platform;
  arch?: string;
  resourcesPath?: string;
  serverRuntimeRoot?: string;
  /** 仅组合根/测试提供应用模块位置；从不读取项目 cwd 或任意 binary 环境变量。 */
  modulePath?: string;
  developmentToolsRoot?: string;
}
export function bundledMisePath(options: BundledBackendLocation = {}): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!["win32", "darwin", "linux"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error("capability-unavailable: no bundled mise for this platform");
  const binary = platform === "win32" ? "mise.exe" : "mise";
  for (const root of [
    options.resourcesPath,
    options.serverRuntimeRoot,
    options.developmentToolsRoot,
  ])
    if (root && !isAbsolute(root)) throw new Error("Bundled mise root must be absolute");
  if (options.resourcesPath) return join(options.resourcesPath, "tools", "mise", "bin", binary);
  if (options.serverRuntimeRoot)
    return join(options.serverRuntimeRoot, "tools", "mise", "bin", binary);
  const modulePath = (options.modulePath ?? import.meta.filename).replaceAll("\\", "/");
  const asar = modulePath.indexOf("/app.asar/");
  if (asar >= 0) return resolve(modulePath.slice(0, asar), "tools", "mise", "bin", binary);
  let toolsRoot = options.developmentToolsRoot;
  if (!toolsRoot) {
    const source = modulePath.match(
      /^(.*)\/packages\/services\/(?:src|dist)\/runtime-environment\//u,
    );
    const desktop = modulePath.match(/^(.*)\/packages\/desktop\/out\/(?:host|main|scheduler)\//u);
    if (source || desktop)
      toolsRoot = resolve((source ?? desktop)![1]!, "packages/desktop/bundled-tools");
    else return resolve(dirname(modulePath), "tools", "mise", "bin", binary);
  }
  return join(toolsRoot, `${platform}-${arch}`, "mise", "bin", binary);
}
