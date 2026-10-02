import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginManifest } from "@lcode/contracts";
import { isRecord } from "./helpers.js";
import { DEFAULT_VERSION, findPluginManifestPath, writeJsonFile } from "./marketplace-files.js";
import type { PluginMarketplaceEntry } from "./marketplace-types.js";

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry;
  target: string;
}): Promise<void> {
  if (findPluginManifestPath(input.target)) return;
  if (input.entry.strict !== false) return;
  const manifestDir = join(input.target, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeJsonFile(
    join(manifestDir, "plugin.json"),
    createManifestFromMarketplaceEntry(input.entry),
  );
}

export function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string,
): void {
  const loaded = readPluginManifestFromRoot(rootPath, entry);
  const pluginId = `${entry.name}@${marketplace}`;
  if (!loaded) {
    throw new Error(`Plugin manifest not found: ${pluginId}`);
  }
  if (loaded.manifest.name !== entry.name) {
    throw new Error(
      `Plugin manifest name '${loaded.manifest.name}' does not match marketplace entry '${entry.name}'`,
    );
  }
}

export function createManifestFromMarketplaceEntry(
  entry: PluginMarketplaceEntry,
): Record<string, unknown> {
  const raw = { ...entry.raw };
  delete raw.source;
  delete raw.category;
  delete raw.tags;
  delete raw.strict;
  // 商店信息（Store Listing）是目录层展示元数据，不属于插件 manifest；
  // 合成 manifest 时剔除，避免污染 plugin.json 语义（author/homepage 是合法 manifest 字段，保留）。
  delete raw.displayName;
  delete raw.displayName_i18n;
  delete raw.description_i18n;
  delete raw.icon;
  delete raw.privacyPolicy;
  delete raw.termsOfService;
  delete raw.heroImage;
  delete raw.examplePrompts;
  delete raw.examplePrompts_i18n;
  delete raw.requiresPaidPlan;
  return {
    ...raw,
    name: entry.name,
    version: entry.version ?? DEFAULT_VERSION,
  };
}

// 缓存路径段与安装记录的版本来源。优先取插件落盘 plugin.json 里的真实
// version（与加载器 readPluginManifestFromRoot/index.ts 展示版本同源），缺失时才回退到 marketplace
// 条目的 version，最后兜底 DEFAULT_VERSION。读取失败保持宽松回退，校验交给 validateMarketplacePlugin。
export function resolveInstalledPluginVersion(
  rootPath: string,
  entry: PluginMarketplaceEntry,
): string {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.version === "string" &&
        parsed.version.trim().length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // 落到下方回退：manifest 不可读/非法时不应中断安装，版本以条目或默认值兜底。
    }
  }
  return entry.version ?? DEFAULT_VERSION;
}

export function readPluginManifestFromRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
): { manifest: PluginManifest; manifestPath?: string } | null {
  const manifestPath = findPluginManifestPath(rootPath);
  if (manifestPath) {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!PLUGIN_NAME_PATTERN.test(name)) throw new Error(`Invalid plugin name: ${name}`);
    return {
      manifest: {
        ...parsed,
        name,
        version: typeof parsed.version === "string" ? parsed.version : DEFAULT_VERSION,
      } as PluginManifest,
      manifestPath,
    };
  }
  if (entry.strict === false) {
    const rawManifest = createManifestFromMarketplaceEntry(entry);
    return {
      manifest: rawManifest as unknown as PluginManifest,
    };
  }
  return null;
}
