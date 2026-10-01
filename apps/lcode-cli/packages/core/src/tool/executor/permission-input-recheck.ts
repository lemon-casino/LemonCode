import {
  type CollaborationMode,
  type PermissionBrokerRequest,
  type PermissionBrokerResult,
  type PermissionRuleset,
  type TraceContext,
} from "@lcode/contracts";

import type { PermissionDecisionResult, PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolEntry } from "../types.js";
import { applyMemoryFilePermission, targetsMemoryFile } from "./memory-file-permission.js";
import {
  resolveRuntimePermissionCapability,
  resolveRuntimePermissionContext,
} from "./permission-capability.js";
import { buildDefaultPermissionUpdates } from "./permission-suggestions.js";
import type { ToolExecutorDeps } from "./types.js";

interface PermissionHookInputRecheckResult {
  brokerResult?: PermissionBrokerResult;
  permissionDecision?: PermissionDecisionResult;
}

export async function recheckPermissionHookModifiedInput(input: {
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  mode: CollaborationMode;
  modifiedInput: unknown;
  projectRules: PermissionRuleset | null;
  requestId: string;
  signal?: AbortSignal;
  toolCall: ExecutableToolCall;
  traceContext: TraceContext;
}): Promise<PermissionHookInputRecheckResult> {
  const runtimePermissionContext = resolveRuntimePermissionContext(input.deps);
  const permissionContext: PermissionContext = {
    input: input.modifiedInput,
    mode: input.mode,
    prePlanMode: input.deps.sessionModePort?.getPrePlanMode(),
    planEnabled: input.deps.sessionModePort?.isPlanEnabled?.(),
    riskLevel: input.entry.metadata.riskLevel,
    toolName: input.toolCall.name,
    // 与首次判定同源：hook 改过 input 之后，草稿免确认仍要按同一个工作目录复核。
    workingDirectory: input.deps.getWorkingDirectory(),
  };
  const rulePolicy = input.entry.resolvePermissionRulePolicy?.(
    input.modifiedInput,
    runtimePermissionContext,
  );
  let decision = input.deps.permissionService.checkPermission(
    permissionContext,
    resolveRuntimePermissionCapability(input.entry, input.modifiedInput, runtimePermissionContext),
    input.projectRules,
    rulePolicy,
  );
  decision = applyMemoryFilePermission({
    decision,
    executionInput: input.modifiedInput,
    memoryRoot: input.deps.getMemoryRoot?.(),
    toolName: input.toolCall.name,
    workingDirectory: input.deps.getWorkingDirectory(),
    workspaceRoot: input.deps.getWorkspaceRoot(),
  });

  if (decision.decision === "deny") {
    return {
      brokerResult: { decision: "deny", reason: decision.reason },
      permissionDecision: decision,
    };
  }
  // 自动审批 Hook 不能通过改写普通 Bash 输入悄悄加上保留授权；要求重新发起用户可见请求。
  if (decision.approvalSource === "user") {
    return {
      brokerResult: {
        decision: "deny",
        reason:
          "Preview retention requires explicit user approval for this input. Retry as a separate request.",
      },
      permissionDecision: decision,
    };
  }
  if (
    decision.decision !== "ask" ||
    (decision.ruleId !== "rule.project.ask" &&
      !targetsMemoryFile({
        executionInput: input.modifiedInput,
        memoryRoot: input.deps.getMemoryRoot?.(),
        toolName: input.toolCall.name,
        workingDirectory: input.deps.getWorkingDirectory(),
        workspaceRoot: input.deps.getWorkspaceRoot(),
      }))
  ) {
    return {};
  }

  const suggestedPermissionUpdates =
    rulePolicy?.suggestedPermissionUpdates ??
    buildDefaultPermissionUpdates(input.toolCall.name, input.modifiedInput);
  const brokerResult = await input.deps.permissionBroker.requestPermission(
    {
      input: input.modifiedInput,
      mode: input.mode,
      reason: decision.reason ?? `Tool ${input.toolCall.name} requires approval`,
      requestId: input.requestId,
      requestedAt: new Date(),
      riskLevel: decision.riskLevel,
      ruleId: decision.ruleId,
      sessionId: input.deps.sessionId,
      sideEffectScope: decision.sideEffectScope,
      suggestedPermissionUpdates,
      toolCallId: input.toolCall.id as PermissionBrokerRequest["toolCallId"],
      toolName: input.toolCall.name,
      traceId: input.traceContext.traceId,
      turnId: input.traceContext.turnId ?? input.deps.turnId,
    },
    {
      signal: input.signal,
      timeoutMs: input.deps.permissionTimeoutMs,
    },
  );
  return { brokerResult, permissionDecision: decision };
}
