import type {
  CompactLifecyclePayload,
  DynamicWorkflowRunProgressPayload,
  SessionEvent,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnStartedPayload,
} from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import { parseAutomationRunId } from "@lcode/shared";
import { workflowLifecycleFactFromProgress } from "./conversation-telemetry-workflow-facts.js";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@lcode/shared/lcode-protocol-v4";
import { optionalString, recordValue, eventTimestamp } from "./conversation-telemetry-values.js";
import {
  BoundedKeySet,
  BoundedValueMap,
  type CompletedModelRequestIdentity,
  type ConversationTelemetryState,
} from "./conversation-telemetry-state.js";
import { normalizeModelFact } from "./conversation-telemetry-model-facts.js";
import { normalizeToolFact } from "./conversation-telemetry-tool-facts.js";

export { streamingParentToolCallId } from "./conversation-telemetry-values.js";

function automationAdmission(inputId: string | undefined, automationId: string | undefined) {
  if (!inputId || !automationId) return {};
  const parsed = parseAutomationRunId(inputId);
  // inputId 不是本 automation 的 runId（历史入口漏传、异常透传）时不猜触发方式：
  // 只保留关联 ID，避免把普通输入误标成 schedule 或从无关字符串切出伪 scheduledAt。
  if (!parsed || parsed.automationId !== automationId) return { automationId };
  return {
    automationId,
    taskTrigger: parsed.trigger,
    ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
  };
}

function terminalStatus(resultType: string): "success" | "interrupted" | "failed" {
  if (resultType === "success") return "success";
  if (resultType === "cancelled") return "interrupted";
  return "failed";
}

function compactTerminalStatus(
  status: CompactLifecyclePayload["status"],
): "completed" | "failed" | "interrupted" | null {
  switch (status) {
    case "completed":
    case "failed":
    case "interrupted":
      return status;
    default:
      return null;
  }
}

export class ConversationTelemetryFactNormalizer {
  private readonly state: ConversationTelemetryState = {
    firstStreamChunks: new BoundedKeySet(),
    sourceCommandByTurn: new BoundedValueMap<string>(),
    toolNameByCall: new BoundedValueMap<string>(),
    modelBySession: new BoundedValueMap<{ modelName: string; modelProvider: string }>(),
    completedModelRequests: new BoundedValueMap<CompletedModelRequestIdentity[]>(),
  };

  normalize(
    sessionId: string,
    event: SessionEvent,
    runtimeMetadata?: { modelName?: string; modelProvider?: string; memoryEnabled?: boolean },
  ): ConversationTelemetryFact | null {
    const turnId = event.turnId ? String(event.turnId) : undefined;
    const turnKey = turnId ? `${sessionId}\0${turnId}` : undefined;
    const base = {
      ...(runtimeMetadata?.memoryEnabled !== undefined
        ? { memoryEnabled: runtimeMetadata.memoryEnabled }
        : {}),
      version: 1 as const,
      eventId: String(event.id),
      eventSeq: Math.max(0, Math.floor(event.sequenceNumber)),
      occurredAt: eventTimestamp(event),
      sessionId,
      ...(turnId ? { turnId } : {}),
    };
    const sourceCommandId = turnKey ? this.state.sourceCommandByTurn.get(turnKey) : undefined;

    switch (event.type) {
      case SessionEventType.TurnStarted: {
        const payload = event.payload as TurnStartedPayload;
        const backgroundSource =
          payload.backgroundSource === "bash" ||
          payload.backgroundSource === "subagent" ||
          payload.backgroundSource === "workflow"
            ? payload.backgroundSource
            : undefined;
        // 用户轮与 background wake 均由 admission 提供 inputId，不混用持久化 messageId。
        const inputId = optionalString(payload.inputId);
        if (turnKey && inputId) this.state.sourceCommandByTurn.set(turnKey, inputId);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.started",
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...automationAdmission(inputId, optionalString(payload.automationId)),
          ...(optionalString(payload.offPeakTaskId)
            ? { offPeakTaskId: optionalString(payload.offPeakTaskId) }
            : {}),
          ...(payload.offPeakRunType ? { offPeakRunType: payload.offPeakRunType } : {}),
          ...(payload.executionKind ? { executionKind: payload.executionKind } : {}),
          ...(payload.inputSource ? { inputSource: payload.inputSource } : {}),
          ...(backgroundSource ? { backgroundSource } : {}),
        });
      }
      case SessionEventType.ModelNetworkStatus:
      case SessionEventType.ModelStreaming:
      case SessionEventType.ModelComplete:
        return normalizeModelFact(
          this.state,
          { sessionId, turnId, turnKey, sourceCommandId, base },
          event,
        );

      case SessionEventType.ToolCallScheduled:
      case SessionEventType.ToolCallStarted:
      case SessionEventType.ToolCallProgress:
      case SessionEventType.ToolCallResult:
      case SessionEventType.ToolCallError:
      case SessionEventType.PermissionRequested:
      case SessionEventType.PermissionResolved:
      case SessionEventType.PermissionDenied:
        return normalizeToolFact(
          this.state,
          { sessionId, turnId, turnKey, sourceCommandId, base },
          event,
        );

      case SessionEventType.DynamicWorkflowRunProgress: {
        // 动态工作流子代理的归属事实：actor-created 登记、
        // run-settled 结算；其余引擎事件不进埋点。
        return workflowLifecycleFactFromProgress(
          base,
          event.payload as DynamicWorkflowRunProgressPayload,
        );
      }
      case SessionEventType.SubagentSpawned:
      case SessionEventType.SubagentStopped: {
        const payload = recordValue(event.payload);
        const agentId = optionalString(payload.agentId);
        const childSessionId = optionalString(payload.childSessionId);
        if (!agentId || !childSessionId) return null;
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "subagent.lifecycle",
          ...(sourceCommandId ? { sourceCommandId } : {}),
          phase: event.type === SessionEventType.SubagentSpawned ? "spawned" : "stopped",
          agentId,
          ...(optionalString(payload.agentType)
            ? { agentType: optionalString(payload.agentType) }
            : {}),
          childSessionId,
          ...(optionalString(payload.parentToolCallId)
            ? { parentToolCallId: optionalString(payload.parentToolCallId) }
            : {}),
          background: payload.background === true,
          ...(optionalString(payload.status) ? { status: optionalString(payload.status) } : {}),
          // stopped 可独立收口后台埋点；保留 Runtime 已有错误，避免失败汇总丢失原因。
          ...(event.type === SessionEventType.SubagentStopped && optionalString(payload.error)
            ? { errorMessage: optionalString(payload.error) }
            : {}),
        });
      }
      case SessionEventType.TurnComplete: {
        const payload = event.payload as TurnCompletePayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: terminalStatus(payload.resultType),
          resultType: payload.resultType,
          durationMs: payload.duration,
          tokenCount: payload.tokenCount,
          toolCallCount: payload.toolCallCount,
          ...(payload.resultType === "cancelled"
            ? {
                errorCode: "USER_INTERRUPT",
                errorMessage: "User stopped generation",
              }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(payload.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        });
        this.clearTurn(turnKey);
        return fact;
      }
      case SessionEventType.TurnError: {
        const payload = event.payload as TurnErrorPayload;
        const directSourceCommandId = optionalString(payload.inputId) ?? sourceCommandId;
        const fact = conversationTelemetryFactSchema.parse({
          ...base,
          kind: "turn.terminal",
          ...(directSourceCommandId ? { sourceCommandId: directSourceCommandId } : {}),
          status: "failed",
          errorCode: payload.error.code ?? payload.error.type,
          errorMessage: payload.error.message,
          ...(payload.error.retryable !== undefined
            ? { errorRetryable: payload.error.retryable }
            : {}),
          ...(payload.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(payload.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          turnPhase: payload.turnPhase,
        });
        this.clearTurn(turnKey);
        return fact;
      }
      case SessionEventType.CompactCompleted:
      case SessionEventType.CompactFailed: {
        const payload = event.payload as CompactLifecyclePayload;
        const status = compactTerminalStatus(payload.status);
        if (!status) return null;
        const observedModel = this.state.modelBySession.get(sessionId);
        const model =
          observedModel ??
          (runtimeMetadata?.modelName || runtimeMetadata?.modelProvider
            ? {
                modelName: runtimeMetadata.modelName ?? "",
                modelProvider: runtimeMetadata.modelProvider ?? "",
              }
            : undefined);
        return conversationTelemetryFactSchema.parse({
          ...base,
          kind: "compaction.terminal",
          ...(payload.sourceCommandId ? { sourceCommandId: payload.sourceCommandId } : {}),
          operationId: payload.operationId,
          ...(payload.messageId ? { messageId: String(payload.messageId) } : {}),
          ...(payload.summaryMessageId
            ? { summaryMessageId: String(payload.summaryMessageId) }
            : {}),
          status,
          trigger: payload.trigger,
          ...(payload.compactReason ? { compactReason: payload.compactReason } : {}),
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
          ...(payload.maxAttempts !== undefined ? { maxAttempts: payload.maxAttempts } : {}),
          ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
          ...(payload.endedAt !== undefined ? { endedAt: payload.endedAt } : {}),
          ...(payload.preCompactTokenCount !== undefined
            ? { preCompactTokenCount: payload.preCompactTokenCount }
            : {}),
          ...(payload.postCompactTokenCount !== undefined
            ? { postCompactTokenCount: payload.postCompactTokenCount }
            : {}),
          ...(payload.truePostCompactTokenCount !== undefined
            ? { truePostCompactTokenCount: payload.truePostCompactTokenCount }
            : {}),
          ...(model ? model : {}),
        });
      }
      default:
        return null;
    }
  }

  private clearTurn(turnKey: string | undefined): void {
    if (!turnKey) return;
    this.state.sourceCommandByTurn.delete(turnKey);
    this.state.firstStreamChunks.deletePrefix(`${turnKey}\0`);
    this.state.toolNameByCall.deletePrefix(`${turnKey}\0`);
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    this.state.sourceCommandByTurn.deletePrefix(prefix);
    this.state.firstStreamChunks.deletePrefix(prefix);
    this.state.toolNameByCall.deletePrefix(prefix);
    this.state.modelBySession.delete(sessionId);
    this.state.completedModelRequests.deletePrefix(prefix);
  }
}
