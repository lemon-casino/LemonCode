import type { TraceContext, TurnId, SessionEvent, ToolExecutionSpanWriter } from "@lcode/contracts";
import type { ExecutableToolCall, ToolExecutionContext } from "../types.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";

export function createToolExecutionContext(input: {
  deps: ToolExecutorDeps;
  canonicalToolCall: ExecutableToolCall;
  traceContext: TraceContext;
  traceId: TraceContext["traceId"];
  turnId: TurnId | undefined;
  abortSignal: AbortSignal;
  emitEvent: ((event: SessionEvent) => Promise<void>) | undefined;
  telemetry: ToolExecutionSpanWriter | undefined;
  options: ToolExecuteOptions | undefined;
  recordReadFileStateMetadata: ToolExecutionContext["recordReadFileStateMetadata"];
  recordSkillTelemetryMetadata: ToolExecutionContext["recordSkillTelemetryMetadata"];
}): ToolExecutionContext {
  const {
    deps,
    canonicalToolCall,
    traceContext,
    traceId,
    turnId,
    abortSignal,
    emitEvent,
    telemetry,
    options,
    recordReadFileStateMetadata,
    recordSkillTelemetryMetadata,
  } = input;
  const model = options?.model ?? deps.model;
  const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
  const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
    bashAvailable: deps.registry.has("Bash"),
  });
  return {
    toolCallId: canonicalToolCall.id,
    telemetry,
    automationTurn: options?.automationTurn,
    offPeakTurn: options?.offPeakTurn,
    traceContext,
    traceId,
    spanId: traceContext.spanId,
    parentSpanId: traceContext.parentSpanId,
    abortSignal,
    backgroundTaskControlPort: deps.backgroundTaskControlPort,
    emitEvent,
    executionPort: deps.executionPort,
    browserControlPort: deps.browserControlPort,
    browserDocumentationRoot: deps.browserDocumentationRoot,
    fileSystemPort: deps.fileSystemPort,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    pdfDocumentPort: deps.pdfDocumentPort,
    // 工具内部的模型请求默认把状态事件发进会话：deadline 暂停与 driver 相位都靠这条流。
    model: withDefaultToolModelStatusSink(
      model,
      createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
    ),
    subagentModelOverride: options?.subagentModelOverride,
    embeddedSearch: {
      ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
      enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
      ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
    },
    skillPort: deps.skillPort,
    subagentPort: deps.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    artifactStore: deps.artifactStore,
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    sessionStore: deps.sessionStore,
    sessionModePort: deps.sessionModePort,
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: deps.runtimeTaskRegistry,
    readFileState: deps.readFileState,
    recordReadFileStateMetadata,
    recordSkillTelemetryMetadata,
    bashShellSelection,
    setWorkingDirectory: deps.setWorkingDirectory,
    workingDirectory: deps.getWorkingDirectory(),
    workspaceRoot: deps.getWorkspaceRoot(),
    workspaceIdentity: deps.workspaceIdentity,
    remoteSessionId: deps.remoteSessionId,
    clientMode: deps.clientMode,
    deliveryKind: deps.deliveryKind,
    memoryRoot: deps.getMemoryRoot?.(),
    runtimeScope: deps.runtimeScope,
    providerVisibleToolNames: deps.registry
      .list()
      .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
    sessionId: deps.sessionId,
    turnId,
  };
}
