import type { RiskLevel } from "@lcode/contracts";
import type {
  PermissionContext,
  PermissionToolCapability,
  ResolvedPermissionCapability,
} from "./service-types.js";

export function getRiskLevel(
  toolName: string,
  toolCapability?: PermissionToolCapability,
): RiskLevel {
  if (toolCapability?.riskLevel) {
    return toolCapability.riskLevel;
  }

  if (isReadOnlyTool(toolName)) {
    return "low";
  }

  if (isWriteTool(toolName)) {
    return "medium";
  }

  if (isDestructiveTool(toolName)) {
    return "high";
  }

  return "medium";
}

function isReadOnlyTool(name: string): boolean {
  return new Set([
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "Agent",
    "Task",
    "Skill",
  ]).has(name);
}

function isWriteTool(name: string): boolean {
  return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
}

function isDestructiveTool(name: string): boolean {
  return new Set(["Bash"]).has(name);
}

export function resolveCapability(
  context: PermissionContext,
  toolCapability: PermissionToolCapability | undefined,
  resolveRiskLevel: typeof getRiskLevel,
): ResolvedPermissionCapability {
  return {
    allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
    alwaysAsk:
      (toolCapability?.permission?.approvalSource ?? toolCapability?.approvalSource) === "user" ||
      (toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false),
    approvalSource: toolCapability?.permission?.approvalSource ?? toolCapability?.approvalSource,
    permissionReason: toolCapability?.permission?.reason,
    readOnly: toolCapability?.readOnly ?? isReadOnlyTool(context.toolName),
    destructive: toolCapability?.destructive ?? isDestructiveTool(context.toolName),
    requiresUserInteraction:
      toolCapability?.requiresUserInteraction ??
      (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
        "userInteraction",
    sideEffectScope:
      toolCapability?.permission?.sideEffectScope ??
      toolCapability?.sideEffectScope ??
      (isReadOnlyTool(context.toolName) ? "none" : "workspace"),
    riskLevel:
      toolCapability?.permission?.riskLevel ?? resolveRiskLevel(context.toolName, toolCapability),
    needsApproval:
      toolCapability?.permission?.needsApproval ??
      toolCapability?.needsApproval ??
      !isReadOnlyTool(context.toolName),
    permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
    permissionName: toolCapability?.permission?.permission,
  };
}
