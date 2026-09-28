import {
  CoreErrorType,
  HookOutcome,
  createCoreError,
  isCoreError,
  type HookExecutionDescriptor,
  type HookInput,
  type Logger,
} from "@lcode/contracts";
import { matchesHookMatcher } from "./output.js";
import type { HookRegistration, HookRunOptions } from "./types.js";

export const HOOK_TIMEOUT_ABORT_REASON = Symbol("hook-timeout");

export function resolveHookRunAdmission(
  hook: HookRegistration,
  input: HookInput,
  logger?: Logger,
): { allowed: boolean; reasonCode?: string; skipLifecycle?: boolean } {
  if (!hook.admission) return { allowed: true };
  try {
    return hook.admission(input);
  } catch (error) {
    // 安全 gate 自身异常时不能继续创建进程或后台任务。
    logger?.warn("Hook admission gate failed closed", {
      error: error instanceof Error ? error.message : String(error),
      event: "hook.admission.failed_closed",
      hookEventName: input.hookEventName,
      module: "core.hooks",
      source: hook.source,
    });
    return { allowed: false, reasonCode: "workspace_hooks_blocked_untrusted" };
  }
}

export function matchesAnyHookMatcher(
  options: HookRunOptions,
  matcher: string | undefined,
): boolean {
  if (!matcher) return true;
  const matchValues = [
    ...(options.matchValues ?? []),
    ...(options.matchValue ? [options.matchValue] : []),
  ];

  if (matchValues.length === 0) return true;
  return [...new Set(matchValues)].some((matchValue) => matchesHookMatcher(matchValue, matcher));
}

export function linkAbortSignal(
  parentSignal: AbortSignal | undefined,
  childController: AbortController,
): () => void {
  if (!parentSignal) return () => {};
  const abortChild = () => {
    if (!childController.signal.aborted) childController.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    abortChild();
    return () => {};
  }
  parentSignal.addEventListener("abort", abortChild);
  return () => parentSignal.removeEventListener("abort", abortChild);
}

export function createHookTimeoutError(timeoutMs: number): Error {
  return createCoreError(CoreErrorType.ToolTimeout, `Hook timed out after ${timeoutMs}ms`, {
    recoverable: true,
  });
}

export function createHookCancelledError(): Error {
  return createCoreError(CoreErrorType.ToolCancelled, "Hook execution cancelled", {
    recoverable: true,
  });
}

export function resolveHookFailureOutcome(error: unknown): HookOutcome {
  if (!isCoreError(error)) return HookOutcome.Failed;
  if (error.type === CoreErrorType.ToolTimeout) return HookOutcome.TimedOut;
  if (error.type === CoreErrorType.ToolCancelled) return HookOutcome.Cancelled;
  return HookOutcome.Failed;
}

export function readHookErrorMessage(error: unknown): string {
  if (isCoreError(error) && error.cause instanceof Error) {
    return error.cause.message || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function resolveHookDescriptor(
  hook: HookRegistration,
  defaultTimeoutMs: number,
  input: HookInput,
): HookExecutionDescriptor {
  if (typeof hook.descriptor === "function") return hook.descriptor(input);
  return (
    hook.descriptor ?? {
      clientVisible: false,
      commandDisplay: hook.source ?? "Internal hook",
      executionMode: hook.async === true ? "background" : "foreground",
      executionType: "process",
      sourceKind: "internal",
      timeoutMs: hook.timeoutMs ?? defaultTimeoutMs,
    }
  );
}
