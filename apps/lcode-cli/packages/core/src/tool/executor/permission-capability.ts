import type { ModelToolSideEffectScope, PermissionBrokerResult } from "@lcode/contracts";
import type { PermissionToolCapability } from "../../permission/service.js";
import type { ToolEntry, ToolRuntimePermissionCapabilityContext } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";

export function scopePermissionApprovalResult(
  result: PermissionBrokerResult,
  approvalSource: PermissionToolCapability["approvalSource"],
): PermissionBrokerResult {
  // 用户保留授权只绑定本次调用；偏斜客户端也不能给后续请求写入宽泛 allow。
  return approvalSource === "user"
    ? { ...result, permissionUpdates: undefined, sessionPermissionUpdates: undefined }
    : result;
}

export function resolveRuntimePermissionCapability(
  entry: ToolEntry,
  input: unknown,
  context: ToolRuntimePermissionCapabilityContext,
): PermissionToolCapability {
  const runtimeCapability = entry.resolvePermissionCapability?.(input, context);
  return {
    ...entry.metadata,
    ...runtimeCapability,
    // capability group is provenance, not a runtime/model-controlled override.
    permissionCapabilityGroup: entry.permissionCapabilityGroup,
    permission: {
      ...entry.permission,
      ...runtimeCapability?.permission,
    },
  };
}

/**
 * 一次调用**解析后**的副作用旗标，挂在 `ToolCallStarted` 上：与权限判定同一次解析，所以 Bash 的只读命令判定等运行时结论一并生效。
 * 订阅者（dynamic-workflow 的 driver）据它在 handler 动手之前判断这一笔是否会改写工作区。
 */
export function resolveToolCallCapabilityFlags(
  deps: ToolExecutorDeps,
  entry: ToolEntry,
  input: unknown,
): { readOnly?: boolean; sideEffectScope?: ModelToolSideEffectScope } {
  const capability = resolveRuntimePermissionCapability(
    entry,
    input,
    resolveRuntimePermissionContext(deps),
  );
  return { readOnly: capability.readOnly, sideEffectScope: capability.sideEffectScope };
}

export function resolveRuntimePermissionContext(
  deps: ToolExecutorDeps,
): ToolRuntimePermissionCapabilityContext {
  return {
    bashShellSelection: deps.getBashShellSelection?.() ?? deps.bashShellSelection,
    runtimeScope: deps.runtimeScope,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
  };
}
