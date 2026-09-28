import type { TuiSelection, TuiSubmitPromptResult } from "@lcode/tui";
import { resolvePluginDisplayName } from "@lcode/shared";
import type {
  CommandCenterDeps,
  CommandCenterPluginListOutcome,
  CommandCenterPluginSetResult,
} from "../types.js";
import { splitArgs } from "../utils.js";

const PLUGINS_COMMAND_USAGE =
  "Usage: /plugins [list|enable <plugin>|disable <plugin>|uninstall <plugin> --force]";
const ENABLED_MARK = "✓";
const DISABLED_MARK = "○";

export async function handlePluginsCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const tokens = splitArgs(args);
  const action = tokens[0] ?? "list";

  if (action === "list" || action === "status") {
    if (!app.listPlugins) {
      return unavailable(deps);
    }
    const outcome = await app.listPlugins();
    return {
      mode: deps.getMode?.(),
      response: formatPluginsPanelResponse(outcome),
      selection: buildPluginsSelection(outcome, undefined, deps.getLocale?.() ?? "en-US"),
    };
  }

  if (action === "enable" || action === "disable") {
    const [, plugin, extra] = tokens;
    if (!plugin || extra) {
      return {
        mode: deps.getMode?.(),
        response: PLUGINS_COMMAND_USAGE,
      };
    }
    if (!app.setPluginEnabled || !app.listPlugins) {
      return unavailable(deps);
    }
    try {
      const result = await app.setPluginEnabled(plugin, action === "enable");
      const outcome = await app.listPlugins();
      return {
        mode: deps.getMode?.(),
        response: formatPluginSetResult(result),
        selection: buildPluginsSelection(
          outcome,
          result.plugin.id,
          deps.getLocale?.() ?? "en-US",
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        mode: deps.getMode?.(),
        response: `Unable to update plugin ${plugin}: ${message}`,
      };
    }
  }

  if (action === "uninstall") {
    return await handlePluginsUninstall(tokens, deps, app);
  }

  return {
    mode: deps.getMode?.(),
    response: PLUGINS_COMMAND_USAGE,
  };
}

async function handlePluginsUninstall(
  tokens: string[],
  deps: CommandCenterDeps,
  app: Awaited<ReturnType<CommandCenterDeps["getApp"]>>,
): Promise<TuiSubmitPromptResult> {
  const rest = tokens.slice(1);
  const force = rest.includes("--force") || rest.includes("-f");
  const plugin = rest.find((token) => token !== "--force" && token !== "-f");
  const extras = rest.filter(
    (token) => token !== "--force" && token !== "-f" && token !== plugin,
  );
  if (!plugin || extras.length > 0) {
    return {
      mode: deps.getMode?.(),
      response: PLUGINS_COMMAND_USAGE,
    };
  }
  if (!app.uninstallPlugin) {
    return unavailable(deps);
  }
  // 斜杠命令是无状态的，无法做交互式 y/N；卸载这种破坏性操作改用显式 --force 作为确认闸门。
  if (!force) {
    return {
      mode: deps.getMode?.(),
      response: `Uninstalling ${plugin} removes its cache, data, and saved config. Re-run with: /plugins uninstall ${plugin} --force`,
    };
  }
  try {
    const result = await app.uninstallPlugin(plugin);
    const outcome = await app.listPlugins?.();
    return {
      mode: deps.getMode?.(),
      response: result.removed
        ? `Uninstalled plugin ${result.removed.id}. Changes apply to new sessions.`
        : `Plugin not installed: ${plugin}`,
      ...(outcome
        ? {
            selection: buildPluginsSelection(
              outcome,
              undefined,
              deps.getLocale?.() ?? "en-US",
            ),
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to uninstall plugin ${plugin}: ${message}`,
    };
  }
}

function unavailable(deps: CommandCenterDeps): TuiSubmitPromptResult {
  return {
    mode: deps.getMode?.(),
    response: "Plugin management is not available in this client.",
  };
}

function buildPluginsSelection(
  outcome: CommandCenterPluginListOutcome,
  selectedPluginId?: string,
  locale = "en-US",
): TuiSelection {
  const plugins = [...outcome.plugins].sort((left, right) => left.id.localeCompare(right.id));
  return {
    emptyMessage: "No plugins found.",
    help: "Type to filter, Up/Down choose, Enter toggles, Esc closes",
    items: plugins.map((plugin) => {
      const displayName = resolvePluginDisplayName(
        {
          name: plugin.name,
          listing: outcome.pluginListingsById?.[plugin.id],
        },
        locale,
      );
      return {
        command: `/plugins ${plugin.enabled ? "disable" : "enable"} ${plugin.id}`,
        id: plugin.id,
        keywords: [
          plugin.id,
          plugin.name,
          displayName,
          plugin.marketplace,
          plugin.source,
          plugin.description ?? "",
          ...plugin.mcpServerNames,
        ],
        meta: pluginMeta(plugin),
        pending: {
          primary: `${plugin.enabled ? "Disabling" : "Enabling"} ${displayName}`,
          secondary: plugin.id,
          status: `${plugin.enabled ? "Disabling" : "Enabling"} plugin...`,
        },
        primary: `${plugin.enabled ? ENABLED_MARK : DISABLED_MARK} ${displayName}`,
        secondary: plugin.id,
      };
    }),
    placement: "composer",
    prompt: "Choose a plugin to toggle.",
    selectedIndex: Math.max(0, plugins.findIndex((plugin) => plugin.id === selectedPluginId)),
    title: "Plugins",
  };
}

function pluginMeta(plugin: CommandCenterPluginListOutcome["plugins"][number]): string {
  const version = plugin.version ? `v${plugin.version}` : "unversioned";
  const mcp = plugin.mcpServerNames.length > 0 ? plugin.mcpServerNames.join(",") : "no mcp";
  return [
    plugin.enabled ? "enabled" : "disabled",
    `${plugin.source}/${plugin.marketplace}`,
    version,
    `${plugin.skillCount} skill`,
    `${plugin.commandRootCount} command`,
    mcp,
  ].join(" | ");
}

function formatPluginsPanelResponse(outcome: CommandCenterPluginListOutcome): string {
  if (outcome.plugins.length === 0) return "No plugins found.";
  const enabledCount = outcome.plugins.filter((plugin) => plugin.enabled).length;
  return `Plugins: ${enabledCount}/${outcome.plugins.length} enabled. Changes apply to new sessions.`;
}

function formatPluginSetResult(result: CommandCenterPluginSetResult): string {
  const verb = result.enabled ? "Enabled" : "Disabled";
  return `${verb} plugin ${result.plugin.id}. Changes apply to new sessions.`;
}
