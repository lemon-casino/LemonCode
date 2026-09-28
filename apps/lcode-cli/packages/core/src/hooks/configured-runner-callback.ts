import {
  CoreErrorType,
  HookEventName,
  HookJSONOutputSchema,
  createCoreError,
  type ExecutionResult,
  type HookConfig,
  type HookInput,
  type HookJSONOutput,
} from "@lcode/contracts";
import {
  createCompatibleHookStdin,
  createPluginEnvOverlay,
  expandPluginVariables,
} from "./configured-runner-input.js";
import type { ConfiguredHookRunnerOptions, HookCallback, HookCallbackResult } from "./types.js";

export function createConfiguredHookCallback(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  hook: HookConfig,
  matcherIndex: number,
  hookIndex: number,
  execution: { maxOutputBytes: number; timeoutMs: number },
): HookCallback {
  switch (hook.type) {
    case "command":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "shell",
                command: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                shell: hook.shell,
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
    case "process":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "argv",
                file: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                args: (hook.args ?? []).map((arg) =>
                  expandPluginVariables(arg, hook.plugin, input, options.getWorkingDirectory()),
                ),
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
  }
}

function processHookExecutionResult(
  input: HookInput,
  result: ExecutionResult,
  event: HookEventName,
): HookJSONOutput | HookCallbackResult | undefined {
  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    return attachHookDiagnostics(parseHookStdout(result.stdout.text, event), result);
  }

  if (result.exitCode === 2) {
    return attachHookDiagnostics(createExitCodeBlockOutput(input, result), result);
  }

  const message =
    result.error?.message ??
    trimForPreview(result.stderr.text) ??
    `Hook process exited with status ${result.status}`;
  throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook process failed", {
    context: {
      exitCode: result.exitCode,
      hookEventName: event,
      status: result.status,
      stderrPreview: trimForPreview(result.stderr.text),
      stdoutPreview: trimForPreview(result.stdout.text),
    },
    cause: new Error(message),
    recoverable: true,
  });
}

function attachHookDiagnostics(
  output: HookJSONOutput | undefined,
  result: ExecutionResult,
): HookJSONOutput | HookCallbackResult | undefined {
  const stderrPreview = trimForPreview(result.stderr.text);
  const stdoutPreview = result.exitCode === 2 ? trimForPreview(result.stdout.text) : undefined;
  if (!stderrPreview && !stdoutPreview) return output;
  return {
    kind: "hookCallbackResult",
    ...(output ? { output } : {}),
    diagnostics: {
      ...(stderrPreview ? { errorMessage: stderrPreview, stderrPreview } : {}),
      ...(stdoutPreview ? { stdoutPreview } : {}),
    },
  };
}

function parseHookStdout(stdout: string, event: HookEventName): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON stdout 是诊断文本，不能因为 hook 打印日志而让当前动作失败。
    return undefined;
  }

  const validation = HookJSONOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Hook stdout failed HookJSONOutput schema validation",
      {
        context: {
          errors: validation.error.errors.slice(0, 20),
          hookEventName: event,
        },
        recoverable: true,
      },
    );
  }

  return validation.data as HookJSONOutput;
}

function createExitCodeBlockOutput(input: HookInput, result: ExecutionResult): HookJSONOutput {
  const reason =
    trimForPreview(result.stderr.text) ??
    trimForPreview(result.stdout.text) ??
    "Hook blocked execution";

  if (input.hookEventName === HookEventName.PreToolUse) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  if (input.hookEventName === HookEventName.PermissionRequest) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PermissionRequest,
        decision: {
          behavior: "deny",
          message: reason,
        },
      },
    };
  }

  if (input.hookEventName === HookEventName.Stop) {
    return {
      decision: "block",
      reason,
    };
  }

  return {
    continue: false,
    reason,
  };
}

function trimForPreview(value: string, maxLength = 4000): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
