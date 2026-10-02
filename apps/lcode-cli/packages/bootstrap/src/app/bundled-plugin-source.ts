import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import {
  OFFICIAL_PLUGIN_MARKETPLACE,
  type OfficialPluginSeedFile,
  type OfficialPluginSeedPluginSource,
  type OfficialPluginSeedSource,
} from "./bundled-plugin-types.js";

const SEA_PLUGIN_ASSET_PREFIX = "lcode-official-plugins/";

const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".lcode-plugin",
  "README.md",
  // 官方内容插件新增 agents 后，filesystem seed 的顶层白名单未同步，目录被静默裁掉。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser skill 会从官方插件根目录动态导入 scripts/browser-client.mjs。
  // filesystem seed 若漏掉 scripts，Dev 会连接 node_repl 成功却在首次 Browser Use 时导入失败。
  "scripts",
  "skills",
  "templates",
]);

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export function resolveSeedSource(): OfficialPluginSeedSource | undefined {
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  return resolveFilesystemSeedSource();
}

function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    plugins,
  };
}

function resolveFilesystemSeedSource(): OfficialPluginSeedSource | undefined {
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const rootPath = resolveFilesystemPluginRoot(definition);
    if (!rootPath) return [];
    const files = collectFilesystemPluginFiles(rootPath, definition);
    return [
      {
        definition,
        files,
        hash: hashSeedFiles(files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, files),
        rootPath,
      },
    ];
  });
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
  };
}

function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function resolveFilesystemPluginRoot(definition: OfficialPluginDefinition): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of definition.rootCandidates) {
      const rootPath = resolve(baseDir, relativePath);
      if (existsSync(join(rootPath, ".lcode-plugin", "plugin.json"))) return rootPath;
    }
  }
  return undefined;
}

function collectFilesystemPluginFiles(
  rootPath: string,
  definition: OfficialPluginDefinition,
): OfficialPluginSeedFile[] {
  const files: OfficialPluginSeedFile[] = [];
  const allowedTopLevelPaths = new Set([
    ...includedTopLevelPaths,
    ...(definition.runtimeTopLevelPaths ?? []),
  ]);
  for (const sourcePath of walkFiles(rootPath, allowedTopLevelPaths)) {
    const relativePath = toPosixPath(sourcePath.slice(rootPath.length + 1));
    if (!shouldIncludePluginFile(relativePath, allowedTopLevelPaths)) continue;
    const bytes = readFileSync(sourcePath);
    files.push({
      mode: modeForSeedFile(relativePath, statSync(sourcePath).mode),
      path: relativePath,
      sha256: hashBytes(bytes),
      sourcePath,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function* walkFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  depth = 0,
): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (shouldSkipDirectory(entry.name, depth, allowedTopLevelPaths)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, allowedTopLevelPaths, depth + 1);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

export function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
): Buffer {
  if (source.kind === "filesystem" && file.sourcePath) return readFileSync(file.sourcePath);
  const sea = getSeaModule();
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(
    sea.getRawAsset(
      `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${plugin.definition.name}/${plugin.definition.version}/${file.path}`,
    ),
  );
}

function candidateBaseDirs(): string[] {
  // Electron app-server 运行在 resources/glm/lcode.cjs，官方插件资源也随桌面包
  // stage 到同级 packages/*-plugin。候选目录必须优先看入口文件目录，避免生产态退回到
  // monorepo-only 的 __dirname 查找假设。
  return [entrypointDir(), runtimeDir(), process.cwd()].filter(
    (dir): dir is string => typeof dir === "string",
  );
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}

function shouldSkipDirectory(
  name: string,
  depth: number,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  return name === "node_modules" && !(depth === 0 && allowedTopLevelPaths.has(name));
}

function shouldIncludePluginFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}

export function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  // official plugin seed 会重写缓存文件权限。部分插件通过 polyglot shell wrapper
  // 直接执行 hook 脚本，若落盘成 0644 会 permission denied。这里保留源码执行位，
  // 并对 SEA/旧 manifest 缺少 mode 的 hook 脚本兜底。
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (normalizedPath.startsWith("hooks/") && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashText(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(Buffer.from(text));
}
