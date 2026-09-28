import { formatJson } from "@lcode/core";
import type { GlobalOptions, JsonValue, RunContext } from "@lcode/shared-types";
import type {
  SetLCodePluginEnabledResult,
  LCodeAvailablePluginData,
  LCodeInstalledPluginData,
  LCodeMarketplaceSummaryData,
} from "@lcode/bootstrap";
import type { PluginDiagnostic, PluginListItem, PluginListOutcome } from "./plugins-command-shared.js";

export function writeWarnings(ctx: RunContext, diagnostics: readonly PluginDiagnostic[]): void {
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity !== "error");
  if (warnings.length > 0) ctx.stderr.write(formatDiagnosticLines(warnings));
}

export function formatDiagnosticLines(diagnostics: readonly PluginDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${formatDiagnosticLine(diagnostic)}\n`).join("");
}

function formatDiagnosticLine(diagnostic: PluginDiagnostic): string {
  const location = diagnostic.path ? ` (${diagnostic.path})` : "";
  const plugin = diagnostic.pluginId ? ` ${diagnostic.pluginId}` : "";
  return `- [${diagnostic.severity}]${plugin} ${diagnostic.code}: ${diagnostic.message}${location}`;
}

export function formatHumanPluginList(outcome: PluginListOutcome, options: GlobalOptions): string {
  if (outcome.plugins.length === 0) return "No plugins found.\n";

  const lines = [`Plugins (${outcome.plugins.length})`];
  for (const plugin of outcome.plugins) {
    const hookDetails = plugin.hookDetails ?? [];
    const mcp = plugin.mcpServerNames.length > 0 ? plugin.mcpServerNames.join(", ") : "none";
    lines.push(`- ${plugin.id} [${plugin.enabled ? "enabled" : "disabled"}]`);
    lines.push(`  ${plugin.source}/${plugin.marketplace}: ${plugin.rootPath}`);
    lines.push(
      `  skills: ${plugin.skillCount}, commands: ${plugin.commandRootCount}, hooks: ${hookDetails.length}, mcp: ${mcp}`,
    );
  }

  if (options.verbose && outcome.diagnostics.length > 0) {
    lines.push("", `Diagnostics (${outcome.diagnostics.length})`);
    for (const diagnostic of outcome.diagnostics) lines.push(formatDiagnosticLine(diagnostic));
  }
  return `${lines.join("\n")}\n`;
}

export function formatHumanAvailableList(plugins: readonly LCodeAvailablePluginData[]): string {
  if (plugins.length === 0) return "No plugins available from configured marketplaces.\n";
  const lines = [`Available plugins (${plugins.length})`];
  for (const plugin of plugins) {
    const version = plugin.version ? ` ${plugin.version}` : "";
    lines.push(`- ${plugin.id}${version} [${plugin.installed ? "installed" : "not installed"}]`);
    if (plugin.description) lines.push(`  ${plugin.description}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatHumanMarketplaceList(
  marketplaces: readonly LCodeMarketplaceSummaryData[],
): string {
  if (marketplaces.length === 0) return "No marketplaces configured.\n";
  const lines = [`Marketplaces (${marketplaces.length})`];
  for (const marketplace of marketplaces) {
    const official = marketplace.isOfficial ? " [official]" : "";
    lines.push(`- ${marketplace.id}${official}: ${marketplace.pluginCount} plugins`);
    lines.push(`  source: ${formatMarketplaceSource(marketplace.source)}`);
    if (marketplace.refreshFailure) {
      lines.push(`  last refresh failed: ${marketplace.refreshFailure.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatMarketplaceSource(source: Record<string, unknown>): string {
  const kind = typeof source.source === "string" ? source.source : "unknown";
  const locator = ["url", "repo", "path", "package"]
    .map((key) => source[key])
    .find((value): value is string => typeof value === "string");
  return locator ? `${kind} ${locator}` : kind;
}

export function formatHumanPluginSet(result: SetLCodePluginEnabledResult): string {
  const verb = result.enabled ? "Enabled" : "Disabled";
  return `${verb} plugin ${result.plugin.id} in ${result.path}\n`;
}

export function formatHumanPluginUninstall(
  removed: LCodeInstalledPluginData | null,
  target: string,
): string {
  if (!removed) return `Plugin not installed: ${target}\n`;
  return `Uninstalled plugin ${removed.id}\n`;
}

export const formatPluginSetJson = (result: SetLCodePluginEnabledResult): string =>
  formatJson({
    enabled: result.enabled,
    path: result.path,
    plugin: formatPluginJson(result.plugin, []),
  });

/** 已加载插件的 JSON 形态；诊断按 pluginId 归到各自条目上，顶层不再有 cwd/diagnostics 包装。 */
export function formatPluginJson(
  plugin: PluginListItem,
  diagnostics: readonly PluginDiagnostic[],
) {
  return {
    commandRootCount: plugin.commandRootCount,
    dataPath: plugin.dataPath,
    enabled: plugin.enabled,
    id: plugin.id,
    manifestPath: plugin.manifestPath,
    marketplace: plugin.marketplace,
    declaredMcpServerNames: plugin.declaredMcpServerNames,
    mcpServerNames: plugin.mcpServerNames,
    hookDetails: (plugin.hookDetails ?? []).map(formatHookDetailJson),
    name: plugin.name,
    rootPath: plugin.rootPath,
    skillCount: plugin.skillCount,
    skillRootCount: plugin.skillRootCount,
    source: plugin.source,
    diagnostics: diagnostics
      .filter((diagnostic) => diagnostic.pluginId === plugin.id)
      .map(formatDiagnosticJson),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatAvailablePluginJson(plugin: LCodeAvailablePluginData) {
  return {
    id: plugin.id,
    installed: plugin.installed,
    marketplace: plugin.marketplace,
    name: plugin.name,
    ...(plugin.componentTypes ? { componentTypes: plugin.componentTypes } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatInstalledPluginJson(plugin: LCodeInstalledPluginData) {
  return {
    enabled: plugin.enabled,
    id: plugin.id,
    marketplace: plugin.marketplace,
    name: plugin.name,
    scope: plugin.scope,
    ...(plugin.componentTypes ? { componentTypes: plugin.componentTypes } : {}),
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.installPath ? { installPath: plugin.installPath } : {}),
    ...(plugin.installedAt ? { installedAt: plugin.installedAt } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}

export function formatMarketplaceJson(marketplace: LCodeMarketplaceSummaryData) {
  return {
    id: marketplace.id,
    isOfficial: marketplace.isOfficial,
    name: marketplace.name,
    pluginCount: marketplace.pluginCount,
    // marketplace source 在 bootstrap 契约里是 Record<string, unknown>，实际总是 JSON 可序列化对象。
    source: marketplace.source as JsonValue,
    ...(marketplace.description ? { description: marketplace.description } : {}),
    ...(marketplace.lastUpdated ? { lastUpdated: marketplace.lastUpdated } : {}),
    ...(marketplace.refreshFailure ? { refreshFailure: marketplace.refreshFailure } : {}),
  };
}

function formatHookDetailJson(hook: PluginListItem["hookDetails"][number]) {
  return {
    command: hook.command,
    event: hook.event,
    runnable: hook.runnable,
    sourcePath: hook.sourcePath,
    type: hook.type,
    ...(hook.args ? { args: hook.args } : {}),
    ...(hook.async !== undefined ? { async: hook.async } : {}),
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
    ...(hook.statusMessage !== undefined ? { statusMessage: hook.statusMessage } : {}),
    ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}),
    ...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
  };
}

export function formatDiagnosticJson(diagnostic: PluginDiagnostic) {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
  };
}
