import {
  CoreErrorType,
  HookEventName,
  isCoreError,
  type CollaborationMode,
  type PermissionBrokerResult,
  type TraceContext,
} from "@lcode/contracts";
import type { HookRunResult } from "../../hooks/index.js";
import type { PermissionDecisionResult } from "../../permission/service.js";
import { hookMatcherToolNamesForTool } from "../compat.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { previewHookValue } from "./utils.js";

export async function runPreToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  entry: ToolEntry,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PreToolUse,
      mode,
      riskLevel: entry.metadata.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: entry.metadata.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPermissionRequestHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  permissionDecision: PermissionDecisionResult,
  mode: CollaborationMode,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<PermissionBrokerResult | undefined> {
  if (!deps.hookRunner) return undefined;
  const hookResult = await deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PermissionRequest,
      mode,
      reason: permissionDecision.reason ?? `Tool ${toolCall.name} requires approval`,
      requestId,
      riskLevel: permissionDecision.riskLevel,
      sessionId: deps.sessionId,
      sideEffectScope: permissionDecision.sideEffectScope,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
  const decision = hookResult.permissionRequestResult;
  if (hookResult.preventContinuation) {
    return {
      decision: "deny",
      reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
    };
  }
  if (!decision) {
    if (hookResult.permissionBehavior === "deny") {
      return {
        decision: "deny",
        reason: hookResult.stopReason ?? "Denied by PermissionRequest hook",
      };
    }
    return hookResult.permissionBehavior === "allow"
      ? {
          decision: "allow",
          reason: "Allowed by PermissionRequest hook",
        }
      : undefined;
  }
  if (decision.behavior === "deny") {
    return {
      decision: "deny",
      reason: decision.message ?? "Denied by PermissionRequest hook",
    };
  }
  const permissionUpdates = decision.permissionUpdates ?? decision.updatedPermissions;
  return decision.updatedInput === undefined
    ? {
        decision: "allow",
        permissionUpdates,
        reason: "Allowed by PermissionRequest hook",
      }
    : {
        decision: "modify",
        modifiedInput: decision.updatedInput,
        permissionUpdates,
        reason: "Allowed with modified input by PermissionRequest hook",
      };
}

export async function runPostToolUseHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  output: unknown,
  artifactPath: string | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  return deps.hookRunner.run(
    {
      artifactRefs: artifactPath ? [artifactPath] : undefined,
      cwd: deps.getWorkingDirectory(),
      hookEventName: HookEventName.PostToolUse,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      toolResponse: output,
      toolResultPreview: previewHookValue(output),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export async function runPostToolUseFailureHooks(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  error: unknown,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!deps.hookRunner) return { additionalContexts: [] };
  const normalized = error instanceof Error ? error : new Error(String(error));
  return deps.hookRunner.run(
    {
      cwd: deps.getWorkingDirectory(),
      error: {
        message: normalized.message,
        type: isCoreError(normalized) ? normalized.type : normalized.name,
      },
      hookEventName: HookEventName.PostToolUseFailure,
      isInterrupt: isCoreError(normalized) && normalized.type === CoreErrorType.ToolCancelled,
      mode: deps.getMode(),
      sessionId: deps.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: toolCall.id,
      toolInput: input,
      toolName: toolCall.name,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId ?? deps.turnId,
    },
    {
      matchValue: toolCall.name,
      matchValues: hookMatcherToolNamesForTool(toolCall.name),
      signal,
    },
  );
}

export function applyPreToolPermissionDecision(
  permissionDecision: PermissionDecisionResult,
  hookResult: HookRunResult,
  mode: CollaborationMode,
): PermissionDecisionResult {
  if (permissionDecision.decision === "deny") return permissionDecision;
  // alwaysAsk 声明出来的确认（如 workflow 运行确认）不能被 PreToolUse hook
  // 的整体 allow 悄悄抹掉——那等于给"任何模式都要问"开了一个静默后门。自动化仍有正规出口：
  // PermissionRequest hook 可以应答这次弹窗（见 runPermissionRequestHooks）。
  if (
    hookResult.permissionBehavior === "allow" &&
    permissionDecision.decision === "ask" &&
    !permissionDecision.alwaysAsk
  ) {
    return {
      ...permissionDecision,
      allowed: true,
      decision: "allow",
      escalated: false,
      mode,
      reason: hookResult.hookPermissionDecisionReason ?? "Tool was allowed by PreToolUse hook",
      ruleId: "hook.PreToolUse.allow",
    };
  }
  if (hookResult.permissionBehavior === "ask" && permissionDecision.decision === "allow") {
    return {
      ...permissionDecision,
      allowed: false,
      decision: "ask",
      escalated: true,
      mode,
      reason:
        hookResult.hookPermissionDecisionReason ?? "Tool requires approval by PreToolUse hook",
      ruleId: "hook.PreToolUse.ask",
    };
  }
  return permissionDecision;
}

export function formatHookAdditionalContexts(additionalContexts: string[]): string {
  return [
    "[Hook additional context]",
    ...additionalContexts.map((context, index) => `#${index + 1}\n${context}`),
  ].join("\n");
}
