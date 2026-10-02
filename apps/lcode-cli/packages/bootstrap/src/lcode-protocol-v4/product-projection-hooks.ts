// Hook invocation 生命周期、pending 归位和 rewind 墓碑的展示归约。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type {
  ProductProjectionState,
  HookInvocationRowContent,
} from "./product-projection-state.js";
import {
  type SessionEvent,
  type HookRunLifecyclePayload,
  SessionEventType,
} from "@lcode/contracts";
import type {
  ConversationDelta,
  HookExecutionProjection,
  HookInvocationRow,
} from "@lcode/shared/lcode-protocol-v4";
import { findRow, ms, turnIdOf, rowBase } from "./product-projection-rows.js";
import { controlPatch } from "./product-projection-session.js";

type HookRunLifecycleHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "hookRowIdByInvocationId"
  | "pendingSessionHookInvocations"
  | "rewoundHookInvocationIds"
  | "entityIdByRowId"
  | "productTurnIdByRuntimeTurnId"
  | "currentTurnId"
  | "currentTurnStartedModelOnly"
>;

type HookBlockErrorDeltaHost = Pick<ProductProjectionState, "snapshot">;

type FlushPendingSessionHookInvocationsHost = Pick<
  ProductProjectionState,
  "nextRowId" | "hookRowIdByInvocationId" | "pendingSessionHookInvocations" | "entityIdByRowId"
>;

export function onHookRunLifecycle(
  host: HookRunLifecycleHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HookRunLifecyclePayload;
  const hookInvocationId = payload.hookInvocationId;
  const hookCount = payload.hookCount;
  if (
    !hookInvocationId ||
    !payload.hookRunId ||
    !Number.isInteger(hookCount) ||
    (hookCount ?? 0) <= 0 ||
    !Number.isInteger(payload.hookIndex) ||
    payload.hookIndex < 0
  ) {
    return [];
  }
  if (host.rewoundHookInvocationIds.has(hookInvocationId)) return [];

  const rowId = host.hookRowIdByInvocationId.get(hookInvocationId);
  const existing = rowId === undefined ? undefined : findRow(host, rowId);
  const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
  const pending = host.pendingSessionHookInvocations.get(hookInvocationId);
  const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
  const previousExecution = previousExecutions.find(
    (execution) => execution.hookRunId === payload.hookRunId,
  );
  const descriptor = payload.descriptor;
  if (
    !previousExecution &&
    (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
  ) {
    return [];
  }
  const state = hookExecutionState(event.type);
  const startedAt =
    typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
      ? payload.startedAt
      : (previousExecution?.startedAt ?? ms(event));
  const endedAt = state === "running" ? undefined : ms(event);
  const durationMs =
    typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
      ? Math.max(0, payload.durationMs)
      : endedAt === undefined
        ? undefined
        : Math.max(0, endedAt - startedAt);
  const outcome = hookExecutionOutcome(event.type, payload.outcome);
  const didExecute =
    previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
  const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
  if (sourceKind === undefined || sourceKind === "internal") return [];
  const blockReason = payload.blockReason ?? previousExecution?.blockReason;
  const execution: HookExecutionProjection = {
    hookRunId: String(payload.hookRunId),
    hookIndex: payload.hookIndex,
    didExecute,
    state,
    ...(outcome ? { outcome } : {}),
    ...(blockReason ? { blockReason } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    displayName:
      previousExecution?.displayName ??
      (descriptor
        ? hookExecutionDisplayName(descriptor, payload.hookIndex)
        : `Hook #${payload.hookIndex + 1}`),
    sourceKind,
    ...(previousExecution?.pluginName || descriptor?.pluginName
      ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
      : {}),
    ...(payload.toolName || previousExecution?.toolName
      ? { toolName: payload.toolName ?? previousExecution?.toolName }
      : {}),
  };
  const byRunId = new Map(previousExecutions.map((candidate) => [candidate.hookRunId, candidate]));
  byRunId.set(execution.hookRunId, execution);
  const executions = [...byRunId.values()].toSorted(
    (left, right) => left.hookIndex - right.hookIndex,
  );
  const rowState = hookInvocationState(executions, hookCount as number);
  const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
  const invocationEndedAt =
    rowState === "running"
      ? undefined
      : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

  const content: HookInvocationRowContent = {
    kind: "hookInvocation",
    hookInvocationId,
    hookEventName: payload.hookEventName,
    hookCount: hookCount as number,
    state: rowState,
    startedAt: invocationStartedAt,
    ...(invocationEndedAt !== undefined
      ? {
          endedAt: invocationEndedAt,
          durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
        }
      : {}),
    lane: hookInvocationLane(payload.hookEventName),
    ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
    executions,
  };

  if (existingRow) {
    const blockErrorDelta = hookBlockErrorDelta(host, event, payload, didExecute, blockReason);
    return [
      {
        op: "row.upserted",
        row: {
          ...existingRow,
          ...content,
        },
      },
      ...(blockErrorDelta ? [blockErrorDelta] : []),
    ];
  }

  if (
    pending ||
    !event.turnId ||
    // 维护 turn 排除只属于 SessionStart——首条输入即 /compact 时
    // SessionStart Hook 携带 compact turnId 到达，不能直挂，先入 pending 等
    // 真实 turn。model-only ≠ 维护 turn：background_task / subagent_message /
    // goal continuation 轮同样是 model-only，但它们是会真实跑工具的 agent 轮，
    // 其 PreToolUse/PostToolUse/Stop 必须按 event.turnId 直挂原轮（与 cold
    // merge 归属对齐），否则会被 pending 吞掉、错误堆到下一个用户轮。
    (payload.hookEventName === "SessionStart" &&
      (host.currentTurnId === null || host.currentTurnStartedModelOnly))
  ) {
    // startup SessionStart 虽可能已经携带 runtime turnId，但此时 TurnStarted 尚未建立
    // runtimeTurnId -> productTurnId 映射；提前 append 会把它拆成独立 footer。
    host.pendingSessionHookInvocations.set(hookInvocationId, {
      firstEvent: pending?.firstEvent ?? event,
      content,
    });
    return [];
  }

  const turnId = turnIdOf(host, event);
  const base = rowBase(host, event, turnId, hookInvocationId);
  const row: HookInvocationRow = {
    ...base,
    ...content,
  };
  host.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
  const blockErrorDelta = hookBlockErrorDelta(host, event, payload, didExecute, blockReason);
  return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
}

/**
 * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
 * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
 * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
 */
function hookBlockErrorDelta(
  host: HookBlockErrorDeltaHost,
  event: SessionEvent,
  payload: HookRunLifecyclePayload,
  didExecute: boolean,
  blockReason: string | undefined,
): ConversationDelta | null {
  if (
    event.type !== SessionEventType.HookRunBlocked ||
    payload.hookEventName !== "UserPromptSubmit" ||
    !didExecute ||
    !blockReason
  ) {
    return null;
  }
  const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
    .map((value) => value?.trim())
    .find((value) => value && value !== blockReason);
  const displayReason = diagnosticMessage ?? blockReason;
  const message =
    displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
  const detail = [
    `Hook block reason: ${blockReason}`,
    ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
  ].join("\n");
  return {
    op: "state.updated",
    patch: controlPatch(host, {
      lastError: {
        code: "fault.runtime.hookBlocked",
        message,
        recoverable: false,
        at: ms(event),
        source: "runtime",
        traceId: String(event.traceId),
        ...(detail ? { detail } : {}),
        attribution: {
          source: "runtime",
          reason: "hook_blocked",
        },
      },
    }),
  };
}

export function flushPendingSessionHookInvocations(
  host: FlushPendingSessionHookInvocationsHost,
  turnId: string,
): ConversationDelta[] {
  if (host.pendingSessionHookInvocations.size === 0) return [];
  const deltas: ConversationDelta[] = [];
  for (const [hookInvocationId, pending] of host.pendingSessionHookInvocations) {
    const row: HookInvocationRow = {
      ...rowBase(host, pending.firstEvent, turnId, hookInvocationId),
      ...pending.content,
    };
    host.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }
  host.pendingSessionHookInvocations.clear();
  return deltas;
}

function hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"] {
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  if (
    eventType === SessionEventType.HookRunCompleted ||
    eventType === SessionEventType.HookRunBlocked
  ) {
    return "completed";
  }
  return "running";
}

function hookExecutionOutcome(
  eventType: SessionEvent["type"],
  outcome: HookRunLifecyclePayload["outcome"],
): HookExecutionProjection["outcome"] {
  if (outcome) return outcome;
  if (eventType === SessionEventType.HookRunCompleted) return "success";
  if (eventType === SessionEventType.HookRunBlocked) return "blocked";
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  return undefined;
}

function hookInvocationState(
  executions: readonly HookExecutionProjection[],
  hookCount: number,
): HookInvocationRow["state"] {
  if (
    executions.length < hookCount ||
    executions.some((execution) => execution.state === "running")
  ) {
    return "running";
  }
  return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
}

function hookInvocationLane(
  eventName: HookRunLifecyclePayload["hookEventName"],
): HookInvocationRow["lane"] {
  if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
  return "assistantWork";
}

function unquoteHookDisplayToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, -1);
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return token;
}

function hookCommandLabel(commandDisplay: string): string | undefined {
  const tokens = commandDisplay.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? [];
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = unquoteHookDisplayToken(executableToken).split(/[\\/]/u).at(-1);
  if (!executable) return undefined;
  const scriptToken = tokens[1];
  if (!HOOK_SCRIPT_RUNNERS.has(executable.toLowerCase()) || !scriptToken) return executable;
  const script = unquoteHookDisplayToken(scriptToken);
  if (!script || script.startsWith("-")) return executable;
  const scriptName = script.split(/[\\/]/u).at(-1);
  return scriptName ? `${executable} · ${scriptName}` : executable;
}

function hookExecutionDisplayName(
  descriptor: NonNullable<HookRunLifecyclePayload["descriptor"]>,
  hookIndex: number,
): string {
  const executable = hookCommandLabel(descriptor.commandDisplay);
  return (
    descriptor.statusMessage?.trim() ||
    (descriptor.pluginName && executable
      ? `${descriptor.pluginName} · ${executable}`
      : descriptor.pluginName || executable) ||
    `Hook #${hookIndex + 1}`
  );
}

const HOOK_SCRIPT_RUNNERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "node.exe",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

const USER_PROMPT_HOOK_BLOCK_ERROR_TYPE = "hooks_prompt_block";
