import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookJSONOutput,
  type HookPermissionDecision,
  type HookSpecificOutput,
} from "@lcode/contracts";
import type { HookRunResult } from "./types.js";

export function processHookOutput(
  expectedEvent: HookEventName,
  output: HookJSONOutput | void,
): HookRunResult {
  const result: HookRunResult = {
    additionalContexts: [],
  };
  if (!output) return result;

  if (output.continue === false && expectedEvent !== HookEventName.Stop) {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason;
    if (shouldPreventContinuation(expectedEvent)) {
      result.preventContinuation = true;
    }
    if (isPermissionEvent(expectedEvent)) {
      result.permissionBehavior = "deny";
    }
  }
  if (expectedEvent === HookEventName.Stop && output.continue === true) {
    result.stopShouldContinue = true;
    result.stopReason = output.stopReason ?? output.reason;
  }
  if (output.decision === "approve" && isPermissionEvent(expectedEvent)) {
    result.permissionBehavior = "allow";
  }
  if (output.decision === "block") {
    result.blockRequested = true;
    result.stopReason = output.stopReason ?? output.reason ?? output.systemMessage;
    if (isPermissionEvent(expectedEvent)) result.permissionBehavior = "deny";
    if (shouldPreventContinuation(expectedEvent)) result.preventContinuation = true;
    if (expectedEvent === HookEventName.Stop) {
      result.stopShouldContinue = true;
      if (output.systemMessage) result.additionalContexts.push(output.systemMessage);
      if (output.reason) result.additionalContexts.push(output.reason);
    }
  }
  if (output.additionalContext) result.additionalContexts.push(output.additionalContext);
  if (output.additional_context) result.additionalContexts.push(output.additional_context);

  const specific = output.hookSpecificOutput;
  if (!specific) return result;
  if (specific.hookEventName !== expectedEvent) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook returned wrong event name", {
      context: {
        expectedEvent,
        hookEventName: specific.hookEventName,
      },
      recoverable: true,
    });
  }

  applyHookSpecificOutput(result, specific);
  return result;
}

export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
  target.additionalContexts.push(...next.additionalContexts);
  if (next.blockRequested) {
    target.blockRequested = true;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  if (next.preventContinuation) {
    target.preventContinuation = true;
    target.stopReason = next.stopReason;
  }
  if (next.stopShouldContinue !== undefined) {
    target.stopShouldContinue = next.stopShouldContinue;
    target.stopReason = next.stopReason ?? target.stopReason;
  }
  if (next.updatedInput !== undefined) {
    target.updatedInput = next.updatedInput;
  }
  if (next.permissionRequestResult) {
    target.permissionRequestResult = next.permissionRequestResult;
  }
  if (next.hookPermissionDecisionReason) {
    target.hookPermissionDecisionReason = next.hookPermissionDecisionReason;
  }
  if (next.permissionBehavior) {
    target.permissionBehavior = mergePermissionBehavior(
      target.permissionBehavior,
      next.permissionBehavior,
    );
  }
}

export function matchesHookMatcher(
  matchValue: string | undefined,
  matcher: string | undefined,
): boolean {
  if (!matcher || matcher === "*") return true;
  if (!matchValue) return false;
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) {
    return matcher.split("|").includes(matchValue);
  }
  try {
    return new RegExp(matcher).test(matchValue);
  } catch {
    return false;
  }
}

function isPermissionEvent(event: HookEventName): boolean {
  return event === HookEventName.PreToolUse || event === HookEventName.PermissionRequest;
}

function applyHookSpecificOutput(result: HookRunResult, specific: HookSpecificOutput): void {
  switch (specific.hookEventName) {
    case HookEventName.PreToolUse:
      if (specific.permissionDecision) {
        result.permissionBehavior = specific.permissionDecision;
        result.hookPermissionDecisionReason = specific.permissionDecisionReason;
      }
      if ("updatedInput" in specific && specific.updatedInput !== undefined) {
        result.updatedInput = specific.updatedInput;
      }
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
    case HookEventName.PermissionRequest:
      if (specific.decision) {
        result.permissionRequestResult = specific.decision;
      }
      break;
    case HookEventName.PostToolUse:
    case HookEventName.PostToolUseFailure:
    case HookEventName.UserPromptSubmit:
    case HookEventName.SessionStart:
    case HookEventName.Stop:
      if (specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
      break;
  }
}

function mergePermissionBehavior(
  current: HookPermissionDecision | undefined,
  next: HookPermissionDecision,
): HookPermissionDecision {
  if (current === "deny" || next === "deny") return "deny";
  if (current === "ask" || next === "ask") return "ask";
  return next;
}

function shouldPreventContinuation(event: HookEventName): boolean {
  return (
    event === HookEventName.PreToolUse ||
    event === HookEventName.PermissionRequest ||
    event === HookEventName.UserPromptSubmit
  );
}
