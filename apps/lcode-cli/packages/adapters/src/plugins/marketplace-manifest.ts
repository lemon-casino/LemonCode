import type { PluginStoreListing } from "@lcode/contracts";
import { isRecord } from "./helpers.js";
import type { PluginMarketplaceEntry, PluginMarketplaceManifest } from "./marketplace-types.js";

export const MARKETPLACE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function parseRequiredMarketplaceManifest(value: unknown): PluginMarketplaceManifest {
  const parsed = parseMarketplaceManifest(value);
  if (!parsed) throw new Error("Marketplace manifest is invalid");
  return parsed;
}

export function parseMarketplaceManifest(value: unknown): PluginMarketplaceManifest | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!MARKETPLACE_NAME_PATTERN.test(name)) return null;
  const rawPlugins = value.plugins;
  const pluginEntries = Array.isArray(rawPlugins)
    ? rawPlugins
    : isRecord(rawPlugins)
      ? Object.entries(rawPlugins).map(([pluginName, plugin]) =>
          isRecord(plugin) ? { name: pluginName, ...plugin } : { name: pluginName },
        )
      : [];
  return normalizeMarketplaceManifest({
    ...value,
    name,
    plugins: pluginEntries,
  });
}

export function normalizeMarketplaceManifest(
  value: PluginMarketplaceManifest | Record<string, unknown>,
): PluginMarketplaceManifest {
  if (isPluginMarketplaceManifest(value)) return value;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .filter(isRecord)
        .map((entry): PluginMarketplaceEntry | null => {
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (name.length === 0) return null;
          const dependencies = Array.isArray(entry.dependencies)
            ? entry.dependencies
                .map(normalizeDependencyRef)
                .filter((item): item is string => item !== null)
            : undefined;
          const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((item): item is string => typeof item === "string")
            : undefined;
          const listing = parseEntryStoreListing(entry);
          return {
            name,
            ...(typeof entry.category === "string" ? { category: entry.category } : {}),
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(typeof entry.version === "string" ? { version: entry.version } : {}),
            ...(entry.source !== undefined ? { source: entry.source } : {}),
            ...(typeof entry.cachePath === "string" ? { cachePath: entry.cachePath } : {}),
            ...(dependencies ? { dependencies } : {}),
            ...(typeof entry.strict === "boolean" ? { strict: entry.strict } : {}),
            ...(tags ? { tags } : {}),
            ...(listing ? { listing } : {}),
            raw: entry,
          };
        })
        .filter((entry): entry is PluginMarketplaceEntry => entry !== null)
    : [];
  const allowCrossMarketplaceDependenciesOn = Array.isArray(
    value.allowCrossMarketplaceDependenciesOn,
  )
    ? value.allowCrossMarketplaceDependenciesOn.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined;
  // 目录顶层的 Featured 策展名单：仅接受非空字符串数组，去掉空白项。
  const featured = Array.isArray(value.featured)
    ? value.featured.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    name: String(value.name),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : typeof metadata.description === "string"
        ? { description: metadata.description }
        : {}),
    plugins,
    ...(allowCrossMarketplaceDependenciesOn ? { allowCrossMarketplaceDependenciesOn } : {}),
    ...(typeof metadata.pluginRoot === "string" ? { pluginRoot: metadata.pluginRoot } : {}),
    ...(featured && featured.length > 0 ? { featured } : {}),
    raw: value,
  };
}

/**
 * 从目录条目解析可选的商店展示信息。兼容字符串或对象形式的 author、i18n map 和多值字段；
 * 解析不到有效内容时返回 undefined，避免给每个条目挂空对象。
 */
export function parseEntryStoreListing(
  entry: Record<string, unknown>,
): PluginStoreListing | undefined {
  const readString = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const readStringMap = (key: string): Record<string, string> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string> = {};
    for (const [locale, text] of Object.entries(value)) {
      if (typeof text === "string") map[locale] = text;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };
  const readStringListMap = (key: string): Record<string, string[]> | undefined => {
    const value = entry[key];
    if (!isRecord(value)) return undefined;
    const map: Record<string, string[]> = {};
    for (const [locale, list] of Object.entries(value)) {
      if (!Array.isArray(list)) continue;
      const items = list.filter((item): item is string => typeof item === "string");
      if (items.length > 0) map[locale] = items;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  };

  const listing: PluginStoreListing = {};
  const displayName = readString("displayName");
  if (displayName) listing.displayName = displayName;
  const displayNameI18n = readStringMap("displayName_i18n");
  if (displayNameI18n) listing.displayNameI18n = displayNameI18n;
  const descriptionI18n = readStringMap("description_i18n");
  if (descriptionI18n) listing.descriptionI18n = descriptionI18n;
  for (const key of [
    "icon",
    "category",
    "homepage",
    "privacyPolicy",
    "termsOfService",
    "heroImage",
  ] as const) {
    const value = readString(key);
    if (value) listing[key] = value;
  }
  const author = normalizeAuthorValue(entry.author);
  if (author?.name) listing.author = author.name;
  if (author?.url) listing.authorUrl = author.url;
  const examplePrompts = Array.isArray(entry.examplePrompts)
    ? entry.examplePrompts.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  if (examplePrompts && examplePrompts.length > 0) listing.examplePrompts = examplePrompts;
  const examplePromptsI18n = readStringListMap("examplePrompts_i18n");
  if (examplePromptsI18n) listing.examplePromptsI18n = examplePromptsI18n;
  // 付费套餐提示只认显式布尔 true；字符串 "true"、1 等歧义写法一律按无需套餐处理，
  // 避免目录写错就给免费插件挂上付费提示。
  if (entry.requiresPaidPlan === true) listing.requiresPaidPlan = true;
  return Object.keys(listing).length > 0 ? listing : undefined;
}

/** author 字段兼容 string 与 {name,url}（plugin.json 与目录条目共用此规则）。 */
export function normalizeAuthorValue(value: unknown): { name?: string; url?: string } | undefined {
  if (typeof value === "string") {
    const name = value.trim();
    return name.length > 0 ? { name } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!name && !url) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(url ? { url } : {}),
  };
}

export function normalizeDependencyRef(value: unknown): string | null {
  if (typeof value === "string") return value.replace(/@\^[^@]*$/u, "");
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  const marketplace = typeof value.marketplace === "string" ? value.marketplace.trim() : "";
  return marketplace ? `${name}@${marketplace}` : name;
}

export function isPluginMarketplaceManifest(value: unknown): value is PluginMarketplaceManifest {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    Array.isArray(value.plugins) &&
    isRecord(value.raw)
  );
}
