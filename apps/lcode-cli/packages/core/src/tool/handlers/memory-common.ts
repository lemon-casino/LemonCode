import {
  CoreErrorType,
  createCoreError,
  type FileSystemPort,
  type ProjectMemoryPort,
  type ToolPermissionSpec,
} from "@lcode/contracts";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

export const MEMORY_TOOL_RESULT_BYTES = 192_000;
export const MEMORY_TOOL_TIMEOUT_MS = 120_000;
export const memoryToolPolicies = {
  configuredHooks: "skip" as const,
  resultBudget: {
    maxInlineBytes: MEMORY_TOOL_RESULT_BYTES,
    maxModelBytes: MEMORY_TOOL_RESULT_BYTES,
    strategy: "truncate" as const,
    preview: { maxBytes: MEMORY_TOOL_RESULT_BYTES, direction: "head" as const },
  },
  timeout: {
    defaultMs: MEMORY_TOOL_TIMEOUT_MS,
    maxMs: MEMORY_TOOL_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort" as const,
    userVisibleMessage: "Memory operation cancelled",
  },
  trace: {
    required: true as const,
    propagateToAdapters: true,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  },
};

export const memoryReadPermission: ToolPermissionSpec = {
  permission: "memory.read",
  reason: "Read bounded Project Memory from the current workspace",
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  patternSources: ["toolName"],
  alwaysAllowPatternSources: ["toolName"],
  denyPriority: "beforeAsk",
};
export const memoryManagedPermission: ToolPermissionSpec = {
  permission: "memory.maintenance",
  reason: "Maintain only the enabled workspace memory through validated, version-checked writes",
  riskLevel: "low",
  sideEffectScope: "workspace",
  needsApproval: false,
  patternSources: ["toolName"],
  denyPriority: "beforeAsk",
};

export function requireMemory(
  context: Pick<ToolExecutionContext, "memoryRoot" | "fileSystemPort">,
): {
  rootDir: string;
  fileSystem: FileSystemPort;
  port: ProjectMemoryPort;
} {
  if (!context.memoryRoot || !context.fileSystemPort?.projectMemory) {
    throw memoryError("Project Memory management is unavailable for this workspace or adapter.");
  }
  return {
    rootDir: context.memoryRoot,
    fileSystem: context.fileSystemPort,
    port: context.fileSystemPort.projectMemory,
  };
}

export function assertInteractiveMemoryMutation(
  context: Pick<ToolExecutionContext, "automationTurn" | "offPeakTurn" | "runtimeScope">,
): void {
  if (context.automationTurn || context.offPeakTurn || context.runtimeScope === "subagent") {
    throw memoryError(
      "This memory maintenance entry is unavailable to automation, off-peak and subagent turns.",
    );
  }
}

export function memoryError(message: string): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, { recoverable: true });
}

export function memoryToolMetadata(
  name: string,
  description: string,
  writable: boolean,
): ToolEntry["metadata"] {
  return {
    name,
    description,
    readOnly: !writable,
    destructive: false,
    concurrentSafe: !writable,
    sideEffectScope: writable ? "workspace" : "none",
    riskLevel: "low",
    needsApproval: false,
    maxOutputBytes: MEMORY_TOOL_RESULT_BYTES,
  };
}
