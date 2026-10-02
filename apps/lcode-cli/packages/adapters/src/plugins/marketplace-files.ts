import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recoverAtomicTargetSync, writeFileAtomically } from "./atomic-directory.js";
import { fileExists, resolveInside, sanitizePluginId } from "./helpers.js";

export const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";

export const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

export const MARKETPLACE_FILE = "marketplace.json";

export const CLAUDE_MARKETPLACE_FILE = join(".claude-plugin", "marketplace.json");

export const LCODE_MANIFEST_PATH = join(".lcode-plugin", "plugin.json");

export const CLAUDE_MANIFEST_PATH = join(".claude-plugin", "plugin.json");

export const CODEX_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

export const DEFAULT_VERSION = "0.0.0";

export function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

export function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

export function getMarketplaceManifestPath(storageRoot: string, marketplace: string): string {
  return join(storageRoot, "marketplaces", sanitizePluginId(marketplace), MARKETPLACE_FILE);
}

export function findMarketplaceManifestPath(
  rootPath: string,
  explicitPath?: string,
): string | null {
  const candidates = [
    ...(explicitPath ? [explicitPath] : []),
    CLAUDE_MARKETPLACE_FILE,
    MARKETPLACE_FILE,
  ];
  for (const candidate of candidates) {
    const path = resolveInside(rootPath, candidate);
    if (path && fileExists(path)) return path;
  }
  return null;
}

export function findPluginManifestPath(rootPath: string): string | null {
  for (const candidate of [LCODE_MANIFEST_PATH, CLAUDE_MANIFEST_PATH, CODEX_MANIFEST_PATH]) {
    const path = join(rootPath, candidate);
    if (fileExists(path)) return path;
  }
  return null;
}

export function readJsonFileSync(path: string): unknown {
  const readablePath = recoverAtomicTargetSync(path);
  try {
    return JSON.parse(readFileSync(readablePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function getPluginCacheDir(
  storageRoot: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return join(
    storageRoot,
    "cache",
    sanitizePluginId(marketplace),
    sanitizePluginId(name),
    sanitizePluginId(version),
  );
}

export function getPluginDataDir(storageRoot: string, pluginId: string): string {
  // 与 NodePluginAdapter.discoverPluginsSync 的 dataPath 解析保持一致：<storageRoot>/data/<sanitized-id>。
  return join(storageRoot, "data", sanitizePluginId(pluginId));
}

export function parsePluginId(pluginId: string): { marketplace: string; name: string } {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) {
    throw new Error(`Plugin id must use <name>@<marketplace>: ${pluginId}`);
  }
  return {
    name: pluginId.slice(0, at),
    marketplace: pluginId.slice(at + 1),
  };
}

export function qualifyDependency(dependency: string, marketplace: string): string {
  return dependency.includes("@") ? dependency : `${dependency}@${marketplace}`;
}
