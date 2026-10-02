import { getPluginSourceDiagnosticCode } from "@lcode/adapters/plugins";
import type { PluginLoadOutcome } from "@lcode/contracts";

export function createMarketplaceSourceRepointDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_invalid",
    message:
      `Workspace marketplace declaration "${marketplaceId}" conflicts with an existing Host source. ` +
      "Remove the existing marketplace or use a different marketplace id before materializing it.",
    pluginId: marketplaceId,
    severity: "error",
  };
}

export function createReservedMarketplaceDeclarationDiagnostic(
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: "plugin_marketplace_declaration_reserved",
    message:
      `Workspace marketplace declaration "${marketplaceId}" uses a reserved official id and was ignored. ` +
      "Use a different marketplace id for project declarations.",
    pluginId: marketplaceId,
    severity: "warning",
  };
}

export class MarketplaceSourceRepointError extends Error {}

export function toPluginDiagnostic(diagnostic: {
  code: string;
  message: string;
  pluginId?: string;
  severity: "warning" | "error";
}): PluginLoadOutcome["diagnostics"][number] {
  return {
    code: diagnostic.code as PluginLoadOutcome["diagnostics"][number]["code"],
    message: diagnostic.message,
    ...(diagnostic.pluginId ? { pluginId: diagnostic.pluginId } : {}),
    severity: diagnostic.severity,
  };
}

export function toMarketplaceInstallDiagnostic(
  error: unknown,
  pluginId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof MarketplaceSourceRepointError) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_invalid",
      message,
      pluginId,
      severity: "error",
    });
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return toPluginDiagnostic({
      code: sourceCode,
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.startsWith("Plugin not found:")) {
    return toPluginDiagnostic({
      code: "plugin_not_found",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("Cross-marketplace dependency")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cross_marketplace",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("dependency cycle")) {
    return toPluginDiagnostic({
      code: "plugin_dependency_cycle",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return toPluginDiagnostic({
      code: "plugin_dependency_missing",
      message,
      pluginId,
      severity: "error",
    });
  }
  if (message.includes("source is recognized but not supported")) {
    return toPluginDiagnostic({
      code: "plugin_marketplace_source_unsupported",
      message,
      pluginId,
      severity: "error",
    });
  }
  return toPluginDiagnostic({
    code: "plugin_marketplace_invalid",
    message,
    pluginId,
    severity: "error",
  });
}

export function toMarketplaceRefreshDiagnostic(
  error: unknown,
  marketplaceId: string,
): PluginLoadOutcome["diagnostics"][number] {
  const message = error instanceof Error ? error.message : String(error);
  return toPluginDiagnostic({
    code: getPluginSourceDiagnosticCode(error) ?? "plugin_marketplace_invalid",
    message,
    pluginId: marketplaceId,
    severity: "error",
  });
}
