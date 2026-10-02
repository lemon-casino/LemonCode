import { getPluginSourceDiagnosticCode } from "./source-errors.js";
import type { PluginValidationDiagnostic } from "./marketplace-types.js";

export function toValidationDiagnostic(
  error: unknown,
  pluginId?: string,
): PluginValidationDiagnostic {
  if (
    error instanceof UnsupportedMarketplaceSourceError ||
    error instanceof UnsupportedPluginSourceError
  ) {
    return {
      code: "plugin_marketplace_source_unsupported",
      message: error.message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const sourceCode = getPluginSourceDiagnosticCode(error);
  if (sourceCode) {
    return {
      code: sourceCode,
      message: error instanceof Error ? error.message : String(error),
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cross-marketplace dependency")) {
    return {
      code: "plugin_dependency_cross_marketplace",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (message.includes("dependency cycle")) {
    return {
      code: "plugin_dependency_cycle",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  if (
    message.includes("Dependency not found") ||
    message.includes("Marketplace not found for dependency")
  ) {
    return {
      code: "plugin_dependency_missing",
      message,
      ...(pluginId ? { pluginId } : {}),
      severity: "error",
    };
  }
  return {
    code: "plugin_marketplace_invalid",
    message,
    ...(pluginId ? { pluginId } : {}),
    severity: "error",
  };
}

export class UnsupportedMarketplaceSourceError extends Error {
  constructor(source: string) {
    super(`Marketplace source is recognized but not supported in this runtime: ${source}`);
  }
}

export class UnsupportedPluginSourceError extends Error {
  constructor(source: string) {
    super(`Plugin source is recognized but not supported in this runtime: ${source}`);
  }
}
