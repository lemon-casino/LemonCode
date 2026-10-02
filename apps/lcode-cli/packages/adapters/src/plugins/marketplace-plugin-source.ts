import { dirname, join, resolve } from "node:path";
import { directoryExists, isRecord, resolveInside } from "./helpers.js";
import {
  DEFAULT_VERSION,
  getMarketplaceManifestPath,
  getPluginCacheDir,
  throwIfPluginOperationAborted,
} from "./marketplace-files.js";
import { loadMarketplaceManifestSync } from "./marketplace-storage.js";
import { resolveRepositoryPluginSource } from "./marketplace-git-source.js";
import { readZipPluginSourceSha256, resolveZipPluginSource } from "./zip-source.js";
import { UnsupportedPluginSourceError } from "./marketplace-errors.js";
import type {
  PluginMarketplaceEntry,
  PluginMarketplaceManifest,
  ResolvedPluginSourceRoot,
} from "./marketplace-types.js";

export async function resolvePluginSourceRoot(input: {
  entry: PluginMarketplaceEntry;
  manifest?: PluginMarketplaceManifest;
  marketplace: string;
  signal?: AbortSignal;
  sourceRoot?: string;
  storageRoot: string;
}): Promise<ResolvedPluginSourceRoot> {
  throwIfPluginOperationAborted(input.signal);
  const source = input.entry.source;
  const marketplaceDir =
    input.sourceRoot ?? dirname(getMarketplaceManifestPath(input.storageRoot, input.marketplace));
  const manifest =
    input.manifest ?? loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  const pluginBaseDir = resolveMarketplacePluginBaseDir(marketplaceDir, manifest);
  // 内置 official 插件 seed 到 marketplace.json 时 source 写的是裸 kind 字符串
  // "filesystem"/"sea"（见 bootstrap/app/bundled-plugins.ts writeOfficialMarketplace），
  // 原逻辑落到下面的 `typeof source === "string"` 分支，把 "filesystem" 当相对路径解析后抛
  // "Unsupported or missing plugin source: filesystem"，导致市场详情页对内置插件枚举不出组件。
  // 这类插件已落盘在 cachePath（缺失时按 cache/<marketplace>/<name>/<version> 兜底），直接定位即可。
  if (source === "filesystem" || source === "sea") {
    const cachePath = input.entry.cachePath;
    if (cachePath && directoryExists(cachePath)) return { path: cachePath };
    const computed = getPluginCacheDir(
      input.storageRoot,
      input.marketplace,
      input.entry.name,
      input.entry.version ?? DEFAULT_VERSION,
    );
    if (directoryExists(computed)) return { path: computed };
    throw new Error(
      `Bundled plugin cache directory missing: ${input.entry.name}@${input.marketplace}`,
    );
  }
  if (typeof source === "string") {
    const local = resolveInside(pluginBaseDir, source.replace(/^\.\//, ""));
    if (local && directoryExists(local)) return { path: local };
    const fallback = resolve(source);
    if (directoryExists(fallback)) return { path: fallback };
    throw new Error(`Unsupported or missing plugin source: ${source}`);
  }
  if (isRecord(source)) {
    const sourceKind = typeof source.source === "string" ? source.source : "";
    if (sourceKind === "directory") {
      const path = resolve(readRequiredPluginSourceString(source, "path", "directory path"));
      if (directoryExists(path)) return { path };
      throw new Error(`Plugin source directory does not exist: ${path}`);
    }
    if (sourceKind === "github") {
      const repo = readRequiredPluginSourceString(source, "repo", "GitHub repo");
      const url = `https://github.com/${repo}.git`;
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git") {
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: readRequiredPluginSourceString(source, "url", "Git URL"),
      });
    }
    if (sourceKind === "url") {
      const url = readRequiredPluginSourceString(source, "url", "URL");
      const sourceType = typeof source.type === "string" ? source.type : "";
      if (sourceType === "zip") {
        return resolveZipPluginSource({
          headers: readPluginSourceHeaders(source),
          path: readOptionalZipPluginSourcePath(source),
          sha256: readRequiredZipPluginSourceSha256(source),
          signal: input.signal,
          stripRoot: readOptionalZipPluginSourceStripRoot(source),
          url,
        });
      }
      if (sourceType && sourceType !== "git") {
        throw new UnsupportedPluginSourceError(`url:${sourceType}`);
      }
      return resolveRepositoryPluginSource({
        path: typeof source.path === "string" ? source.path : undefined,
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url,
      });
    }
    if (sourceKind === "git-subdir") {
      return resolveRepositoryPluginSource({
        path: readRequiredPluginSourceString(source, "path", "git-subdir path"),
        ref: typeof source.ref === "string" ? source.ref : undefined,
        signal: input.signal,
        sha: readPluginSourceIdentityPin(source),
        url: normalizeGitUrl(readRequiredPluginSourceString(source, "url", "git-subdir URL")),
      });
    }
    if (sourceKind === "npm" || sourceKind === "pip") {
      throw new UnsupportedPluginSourceError(sourceKind);
    }
    // 显式 object source 配置错误时不能降级到 marketplace 内同名目录，否则会安装错误来源。
    throw new Error(
      `Plugin source is invalid or unsupported for ${input.entry.name}@${input.marketplace}: ${sourceKind || "missing kind"}`,
    );
  }
  const localByName = join(pluginBaseDir, input.entry.name);
  if (directoryExists(localByName)) return { path: localByName };
  throw new Error(`Plugin source is not supported for ${input.entry.name}@${input.marketplace}`);
}

export function readPluginSourceSha(source: unknown): string | undefined {
  return readPluginSourceIdentityPin(source);
}

export function readPluginSourceIdentityPin(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  const zipSha256 = readZipPluginSourceSha256(source);
  if (zipSha256) return zipSha256;
  if (typeof source.sha === "string") return source.sha;

  // 兼容旧版及第三方 marketplace 的 source identity 写法。
  if (typeof source.commit === "string") return source.commit;
  return undefined;
}

export function readRequiredZipPluginSourceSha256(source: Record<string, unknown>): string {
  if (typeof source.sha256 === "string") return source.sha256;
  throw new Error("Plugin zip source sha256 is required");
}

export function readRequiredPluginSourceString(
  source: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin ${label} source requires a non-empty ${field}`);
  }
  return value;
}

export function readOptionalZipPluginSourcePath(
  source: Record<string, unknown>,
): string | undefined {
  if (source.path === undefined) return undefined;
  if (typeof source.path === "string") return source.path;
  throw new Error("Plugin zip source path must be a string");
}

export function readOptionalZipPluginSourceStripRoot(
  source: Record<string, unknown>,
): boolean | undefined {
  if (source.stripRoot === undefined) return undefined;
  if (typeof source.stripRoot === "boolean") return source.stripRoot;
  throw new Error("Plugin zip source stripRoot must be a boolean");
}

export function readPluginSourceHeaders(
  source: Record<string, unknown>,
): Record<string, string> | undefined {
  if (source.headers === undefined) return undefined;
  if (!isRecord(source.headers)) {
    throw new Error("Plugin zip source headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.headers)) {
    if (typeof value !== "string") {
      throw new Error(`Plugin zip source header must be a string: ${key}`);
    }
    headers[key] = value;
  }
  return headers;
}

export function normalizeGitUrl(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value) && !value.includes(":")) {
    return `https://github.com/${value}.git`;
  }
  return value;
}

export function resolveMarketplacePluginBaseDir(
  marketplaceDir: string,
  manifest: PluginMarketplaceManifest | null,
): string {
  const pluginRoot = manifest?.pluginRoot;
  if (!pluginRoot) return marketplaceDir;
  const resolved = resolveInside(marketplaceDir, pluginRoot);
  return resolved && directoryExists(resolved) ? resolved : marketplaceDir;
}
