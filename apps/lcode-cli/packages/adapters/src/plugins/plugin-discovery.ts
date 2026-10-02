import { join, resolve } from "node:path";
import type {
  CustomCommandRoot,
  PluginConfig,
  PluginDiagnostic,
  PluginDiscoverRequest,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginOperationOptions,
  PluginPort,
  SkillRoot,
} from "@lcode/contracts";
import {
  LCODE_INLINE_PLUGIN_MARKETPLACE,
  LCODE_OFFICIAL_PLUGIN_MARKETPLACE,
} from "@lcode/contracts";
import { sanitizePluginId, throwIfAborted } from "./helpers.js";
import { loadPluginMcpServerDefinitions } from "./mcp.js";
import { enumeratePluginComponents } from "./plugin-components.js";
import {
  listInstalledPluginRecords,
  resolveInstalledPluginRoot,
} from "./marketplace-installed-storage.js";
import { normalizeAuthorValue } from "./marketplace-manifest.js";
import { inspectPluginHooks, mergeHookEvents } from "./plugin-hooks.js";
import { loadPlugin, scanOfficialCache } from "./plugin-manifest.js";
import { resolveEnabledComponents } from "./plugin-roots.js";
import type {
  LoadedPlugin,
  PluginAbortOptions,
  PluginCandidate,
  PluginComponents,
} from "./types.js";

export const FIRST_PLUGIN_PRIORITY = 1_000;

export const PRIORITY_STEP = 10;

export const UNSUPPORTED_COMPONENT_KEYS = [
  "channels",
  "lspServers",
  "outputStyles",
  "settings",
] as const;

export interface NodePluginAdapterOptions {
  storageRoot: string;
}

export class NodePluginAdapter implements PluginPort {
  constructor(private readonly options: NodePluginAdapterOptions) {}

  async discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome> {
    return this.discoverPluginsSync(request, options);
  }

  discoverPluginsSync(
    request: PluginDiscoverRequest,
    options?: PluginAbortOptions,
  ): PluginLoadOutcome {
    if (!request.config.enabled) return emptyOutcome();

    const diagnostics: PluginDiagnostic[] = [];
    const dataRoot = join(request.storageRoot || this.options.storageRoot, "data");
    const candidates = this.resolveCandidates(request, diagnostics, options);
    const commandRoots: CustomCommandRoot[] = [];
    const hooks: PluginLoadOutcome["hooks"] = {};
    const mcpServers: PluginLoadOutcome["mcpServers"] = {};
    const plugins: PluginMetadata[] = [];
    const seen = new Set<string>();
    const skillRoots: SkillRoot[] = [];
    let priority = FIRST_PLUGIN_PRIORITY;

    for (const candidate of candidates) {
      throwIfAborted(options);
      const loaded = loadPlugin(candidate, diagnostics);
      if (!loaded) continue;
      // 内置（官方）插件被「卸载」后只在 user config 写 suppressedBuiltins 标记。这里在发现层
      // 用插件的权威 id（manifest 名 @ marketplace）过滤，不依赖缓存文件是否已被物理删除——
      // 这样即便 app 升级遗留了旧版本缓存目录、或会话内 facade 持有过时配置，被卸载的内置插件
      // 也不会被重新发现。仅作用于 official 源，inline/cache（市场安装）不受影响。
      if (loaded.source === "official" && request.config.suppressedBuiltins.includes(loaded.id)) {
        continue;
      }
      if (seen.has(loaded.id)) {
        diagnostics.push({
          code: "plugin_duplicate_id",
          message: `Duplicate plugin ignored: ${loaded.id}`,
          path: loaded.rootPath,
          pluginId: loaded.id,
          severity: "warning",
        });
        continue;
      }
      seen.add(loaded.id);
      warnUnsupportedComponents(loaded, diagnostics);

      // candidate.defaultEnabled 在 candidate 构造时无法访问 plugin id,
      // 这里再叠加 bootstrap 提供的 "默认开" 名单 (按 `<name>@<marketplace>` 匹配)。
      const candidateDefaultEnabled =
        candidate.defaultEnabled ||
        (request.officialPluginsEnabledByDefault?.has(loaded.id) ?? false);
      const enabled = resolveEnabled(request.config, loaded.id, candidateDefaultEnabled);
      const dataPath = join(dataRoot, sanitizePluginId(loaded.id));
      // 只从启用后解析出的 component.mcpServers 生成 mcpServerNames，
      // 未启用插件的内置 MCP 就会在管理页完全不可见。这里先读取声明名给 UI 只读展示，
      // 实际 runtime 注入仍只使用 enabled 分支解析出的 component.mcpServers。
      const mcpServerDefinitions = loadPluginMcpServerDefinitions({ diagnostics, loaded });
      const hooksRunnable = canRunPluginHooks(loaded);
      const hookInspection = inspectPluginHooks({
        dataPath,
        diagnostics,
        loaded,
        runnable: hooksRunnable,
      });
      const component = enabled
        ? resolveEnabledComponents({
            dataPath,
            diagnostics,
            env: request.env ?? {},
            hookEvents: hooksRunnable ? hookInspection.events : {},
            hookDetails: hookInspection.details,
            loaded,
            mcpServerDefinitions,
            options: request.config.options[loaded.id] ?? {},
            priority,
            workingDirectory: request.workingDirectory,
          })
        : emptyComponents(hookInspection.details);
      priority += PRIORITY_STEP;

      Object.assign(mcpServers, component.mcpServers);
      mergeHookEvents(hooks, component.hooks);
      skillRoots.push(...component.skillRoots);
      commandRoots.push(...component.commandRoots);
      plugins.push(
        createPluginMetadata(
          loaded,
          component,
          dataPath,
          enabled,
          Object.keys(mcpServerDefinitions),
          request.config.options[loaded.id] ?? {},
        ),
      );
    }

    return {
      commandRoots,
      diagnostics,
      hooks,
      mcpServers,
      plugins,
      skillRoots,
    };
  }

  private resolveCandidates(
    request: Pick<PluginDiscoverRequest, "config" | "officialPluginRoots" | "storageRoot">,
    diagnostics: PluginDiagnostic[],
    options?: PluginAbortOptions,
  ): PluginCandidate[] {
    const candidates: PluginCandidate[] = [];
    for (const rootPath of request.config.dirs) {
      candidates.push({
        defaultEnabled: true,
        marketplace: LCODE_INLINE_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "inline",
      });
    }
    for (const rootPath of request.officialPluginRoots ?? []) {
      candidates.push({
        defaultEnabled: false,
        marketplace: LCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath: resolve(rootPath),
        source: "official",
      });
    }
    candidates.push(
      ...scanOfficialCache(request.storageRoot, diagnostics, options).map((rootPath) => ({
        defaultEnabled: false,
        marketplace: LCODE_OFFICIAL_PLUGIN_MARKETPLACE,
        rootPath,
        source: "official" as const,
      })),
    );
    for (const installed of listInstalledPluginRecords(request.storageRoot)) {
      candidates.push({
        defaultEnabled: false,
        marketplace: installed.marketplace,
        rootPath: resolveInstalledPluginRoot(request.storageRoot, installed),
        source: "cache",
      });
    }
    return candidates;
  }
}

export function createNodePluginAdapter(options: NodePluginAdapterOptions): NodePluginAdapter {
  return new NodePluginAdapter(options);
}

export function discoverNodePluginsSync(
  request: PluginDiscoverRequest,
  options?: PluginAbortOptions,
): PluginLoadOutcome {
  return createNodePluginAdapter({ storageRoot: request.storageRoot }).discoverPluginsSync(
    request,
    options,
  );
}

export function createPluginMetadata(
  loaded: LoadedPlugin,
  component: PluginComponents,
  dataPath: string,
  enabled: boolean,
  declaredMcpServerNames: string[],
  configuredOptions: Record<string, string | number | boolean>,
): PluginMetadata {
  // manifest 的 author/homepage 作为详情页信息区的回退来源（商店 listing 优先）。
  const author = normalizeAuthorValue(loaded.manifest.author);
  const homepage =
    typeof loaded.manifest.homepage === "string" && loaded.manifest.homepage.trim().length > 0
      ? loaded.manifest.homepage
      : undefined;
  return {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    commandRootCount: component.commandRoots.length,
    // 详情 UI 过去靠 plugin.skillCount（权威计数）+ 一条 UI 侧 join（按 pluginName 过滤
    // skillsService 结果）拿名称，二者数据源分离。停用插件走 emptyComponents() 使 skillCount=0、
    // 且 UI join 对停用插件不产出名称（skillsService 里 `if (!enabled) continue`），导致：停用时
    // 整个技能分组消失、启用时只有数量没有名称。这里改为对插件根目录做权威枚举（与启用态无关），
    // 直接把名称+描述随 list 下发，UI 不再需要脆弱的 join。
    components: enumeratePluginComponents(loaded.rootPath, loaded.manifest, { loaded }),
    configuredOptions,
    dataPath,
    declaredMcpServerNames,
    description: loaded.manifest.description,
    enabled,
    id: loaded.id,
    manifestPath: loaded.manifestPath,
    marketplace: loaded.marketplace,
    mcpServerNames: Object.keys(component.mcpServers),
    name: loaded.manifest.name,
    hookDetails: component.hookDetails,
    rootPath: loaded.rootPath,
    skillCount: component.skillCount,
    skillRootCount: component.skillRoots.length,
    source: loaded.source,
    userConfig: loaded.manifest.userConfig,
    version: loaded.manifest.version,
  };
}

export function canRunPluginHooks(_loaded: LoadedPlugin): boolean {
  // 三方 marketplace 插件 hook 默认放行（与内置/官方一致）。
  // 上限：放弃了「仅官方可执行 hook」的信任边界，三方插件 hook 会直接执行；
  // 升级路径：需要逐插件 trust（如 user config 白名单）时，把判断收回这里。
  return true;
}

export function warnUnsupportedComponents(
  loaded: LoadedPlugin,
  diagnostics: PluginDiagnostic[],
): void {
  for (const key of UNSUPPORTED_COMPONENT_KEYS) {
    if (key in loaded.manifest) {
      diagnostics.push({
        code: "plugin_unsupported_component",
        message: `Plugin component is diagnostic-only in this LCode runtime: ${key}`,
        path: loaded.manifestPath,
        pluginId: loaded.id,
        severity: "warning",
      });
    }
  }
}

export function emptyOutcome(): PluginLoadOutcome {
  return {
    commandRoots: [],
    diagnostics: [],
    hooks: {},
    mcpServers: {},
    plugins: [],
    skillRoots: [],
  };
}

export function emptyComponents(hookDetails: PluginHookDetail[] = []): PluginComponents {
  return {
    commandRoots: [],
    hooks: {},
    hookDetails,
    mcpServers: {},
    skillCount: 0,
    skillRoots: [],
  };
}

export function resolveEnabled(config: PluginConfig, id: string, defaultEnabled: boolean): boolean {
  return config.enabledPlugins[id] ?? defaultEnabled;
}
