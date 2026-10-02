import type {
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionEvent,
  ToolCallErrorPayload,
  ToolExecutionTelemetry,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@lcode/shared/lcode-protocol-v4";
import { optionalString, recordValue } from "./conversation-telemetry-values.js";
import {
  type ConversationTelemetryState,
  type TelemetryEventContext,
} from "./conversation-telemetry-state.js";

function skillTelemetryFactFields(
  toolName: string | undefined,
  metadata: unknown,
): Record<string, unknown> {
  if (toolName !== "Skill") return {};
  const value = recordValue(metadata);
  const qualifiedName = optionalString(value.qualifiedName);
  const pluginId = optionalString(value.pluginId);
  const source = optionalString(value.source);
  return {
    ...(qualifiedName ? { skillQualifiedName: qualifiedName } : {}),
    ...(pluginId ? { skillPluginId: pluginId } : {}),
    ...(source ? { skillSource: source } : {}),
  };
}

function mirroredSubagentToolFields(
  payload: Record<string, unknown>,
  display: Record<string, unknown> = {},
) {
  const parentToolCallId =
    optionalString(payload.parentToolCallId) ?? optionalString(display.parentToolCallId);
  const childToolCallId =
    optionalString(payload.childToolCallId) ?? optionalString(display.childToolCallId);
  const agentId = optionalString(payload.agentId) ?? optionalString(display.agentId);
  const agentType = optionalString(payload.agentType) ?? optionalString(display.agentType);
  const childSessionId =
    optionalString(payload.childSessionId) ?? optionalString(display.childSessionId);
  return {
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(childToolCallId ? { childToolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(payload.background === true ? { background: true } : {}),
  };
}

function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  const parsed = recordValue(value);
  return optionalString(recordValue(parsed.automation).automationId);
}

type ToolPerformanceFact = NonNullable<
  Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>["performance"]
>;

function toToolPerformanceFact(
  perf: ToolExecutionTelemetry | undefined,
): ToolPerformanceFact | undefined {
  if (!perf) return undefined;
  const command = perf.detail?.kind === "command" ? perf.detail.command : undefined;
  const filesystem =
    perf.detail?.kind === "filesystem" || perf.detail?.kind === "patch"
      ? perf.detail.filesystem
      : undefined;
  const patch = perf.detail?.kind === "patch" ? perf.detail.patch : undefined;
  const fact: ToolPerformanceFact = {
    ...(perf.totalMs !== undefined ? { totalMs: perf.totalMs } : {}),
    ...(perf.permissionWaitMs !== undefined ? { permissionWaitMs: perf.permissionWaitMs } : {}),
    ...(command?.runMs !== undefined ? { commandRunMs: command.runMs } : {}),
    ...(command?.firstOutputMs !== undefined ? { firstOutputMs: command.firstOutputMs } : {}),
    ...(command?.noOutputMs !== undefined ? { noOutputMs: command.noOutputMs } : {}),
    ...(command?.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    ...(command?.timedOut !== undefined ? { timedOut: command.timedOut } : {}),
    ...(command?.outputBytes !== undefined ? { outputBytes: command.outputBytes } : {}),
    ...(command?.category !== undefined ? { commandCategory: command.category } : {}),
    ...(command?.name !== undefined ? { commandName: command.name } : {}),
    ...(command?.count !== undefined ? { commandCount: command.count } : {}),
    ...(command?.status !== undefined ? { commandStatus: command.status } : {}),
    ...(filesystem?.readMs !== undefined ? { fsReadMs: filesystem.readMs } : {}),
    ...(filesystem?.writeMs !== undefined ? { fsWriteMs: filesystem.writeMs } : {}),
    ...(filesystem?.fileCount !== undefined ? { fileCount: filesystem.fileCount } : {}),
    ...(filesystem?.totalBytes !== undefined ? { totalBytes: filesystem.totalBytes } : {}),
    ...(filesystem?.maxFileBytes !== undefined ? { maxFileBytes: filesystem.maxFileBytes } : {}),
    ...(filesystem?.workspaceKind !== undefined ? { workspaceKind: filesystem.workspaceKind } : {}),
    ...(patch?.matchMs !== undefined ? { patchMatchMs: patch.matchMs } : {}),
    ...(patch?.hunkCount !== undefined ? { hunkCount: patch.hunkCount } : {}),
    ...(patch?.matchAttempts !== undefined ? { matchAttempts: patch.matchAttempts } : {}),
  };
  return Object.keys(fact).length > 0 ? fact : undefined;
}

// 事实关联表仍由 normalizer 拥有；此函数只借用对应生命周期字段。
export function normalizeToolFact(
  state: Pick<ConversationTelemetryState, "toolNameByCall">,
  context: TelemetryEventContext,
  event: SessionEvent,
): ConversationTelemetryFact | null {
  const { sessionId, turnKey, sourceCommandId, base } = context;
  switch (event.type) {
    case SessionEventType.ToolCallScheduled: {
      const payload = event.payload as ToolCallScheduledPayload;
      const rawPayload = recordValue(event.payload);
      const toolCallId = String(payload.toolCallId);
      state.toolNameByCall.set(`${turnKey ?? sessionId}\0${toolCallId}`, payload.toolName);
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "tool.lifecycle",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        phase: "scheduled",
        toolCallId,
        toolName: payload.toolName,
        ...mirroredSubagentToolFields(rawPayload),
      });
    }
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError: {
      const payload = event.payload as
        | ToolCallStartedPayload
        | ToolCallProgressPayload
        | ToolCallResultPayload
        | ToolCallErrorPayload;
      const rawPayload = recordValue(event.payload);
      const toolCallId = String(payload.toolCallId);
      const key = `${turnKey ?? sessionId}\0${toolCallId}`;
      const explicitName = "toolName" in payload ? optionalString(payload.toolName) : undefined;
      const toolName = explicitName ?? state.toolNameByCall.get(key);
      const result =
        event.type === SessionEventType.ToolCallResult ? (payload as ToolCallResultPayload) : null;
      const error =
        event.type === SessionEventType.ToolCallError ? (payload as ToolCallErrorPayload) : null;
      const display = recordValue(result?.result.display);
      // runtime 把 perf 改为 nested detail，旧 normalizer 仍把它
      // 原样塞进扁平 strict fact，导致整条工具终态被丢弃。这里必须只做显式白名单映射，
      // 不能再次透传 detail 或本地诊断用的 command.hash。
      const performance = toToolPerformanceFact(result?.result.perf);
      const phase =
        event.type === SessionEventType.ToolCallStarted
          ? "started"
          : event.type === SessionEventType.ToolCallProgress
            ? "progress"
            : event.type === SessionEventType.ToolCallResult
              ? result?.result.success === false
                ? "failed"
                : "completed"
              : "failed";
      const automationId =
        phase === "completed" && toolName === "CronCreate"
          ? cronCreateAutomationId(result?.result.content)
          : undefined;
      if (phase === "completed" || phase === "failed") state.toolNameByCall.delete(key);
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "tool.lifecycle",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        phase,
        toolCallId,
        ...(toolName ? { toolName } : {}),
        ...(automationId ? { automationId } : {}),
        ...(result ? { durationMs: result.duration } : {}),
        ...(error ? { errorCode: error.error.code ?? error.error.type } : {}),
        ...(error ? { errorMessage: error.error.message } : {}),
        ...(result?.result.error
          ? { errorCode: result.result.error.code ?? result.result.error.type }
          : {}),
        ...(result?.result.error ? { errorMessage: result.result.error.message } : {}),
        ...skillTelemetryFactFields(toolName, error?.skillMetadata ?? result?.skillMetadata),
        // subagent mirror 把父子关联放在工具事件 payload 顶层，旧 normalizer
        // 只读取 result.display，导致 agent_id 等字段在进入 agent_step 前被静默丢弃。
        ...mirroredSubagentToolFields(rawPayload, display),
        ...(performance ? { performance } : {}),
      });
    }
    case SessionEventType.PermissionRequested:
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied: {
      const payload = event.payload as
        | PermissionRequestedPayload
        | PermissionResolvedPayload
        | PermissionDeniedPayload;
      const rawPayload = recordValue(payload);
      const requested =
        event.type === SessionEventType.PermissionRequested
          ? (payload as PermissionRequestedPayload)
          : null;
      const resolved =
        event.type === SessionEventType.PermissionResolved
          ? (payload as PermissionResolvedPayload)
          : null;
      const denied =
        event.type === SessionEventType.PermissionDenied
          ? (payload as PermissionDeniedPayload)
          : null;
      return conversationTelemetryFactSchema.parse({
        ...base,
        kind: "permission.lifecycle",
        ...(sourceCommandId ? { sourceCommandId } : {}),
        phase: requested ? "requested" : resolved ? "resolved" : "denied",
        ...(optionalString(requested?.requestId ?? resolved?.requestId)
          ? { requestId: optionalString(requested?.requestId ?? resolved?.requestId) }
          : {}),
        toolCallId: String(payload.toolCallId),
        ...(requested?.toolName
          ? { toolName: requested.toolName }
          : denied?.toolName
            ? { toolName: denied.toolName }
            : {}),
        ...(optionalString(rawPayload.childSessionId)
          ? { childSessionId: optionalString(rawPayload.childSessionId) }
          : {}),
        ...(rawPayload.background === true ? { background: true } : {}),
        ...(resolved ? { decision: resolved.decision } : {}),
      });
    }
    default:
      return null;
  }
}
