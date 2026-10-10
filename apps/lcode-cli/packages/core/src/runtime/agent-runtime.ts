import { DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@lcode/shared";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type {
  Logger,
  MessageId,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionStorePort,
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
  ImageProcessorPort,
  PdfDocumentPort,
  VideoProcessorPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  HookRunner,
  TurnId,
} from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type { ProjectMemoryRecallIndex } from "../memory/recall/index.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import type {
  ActiveForegroundExecutionState,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ForegroundPromotionLeaseState,
  PendingModelChangeTimeline,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { cloneModelSelection } from "./model-selection.js";
import { validateContextCapsuleReferences } from "../session-context/context-capsule.js";
import type { ExecutionFailoverState } from "@lcode/shared/lcode-protocol-v4";
import {
  createExecutionFailoverPolicyPort,
  type ExecutionFailoverRegistration,
  type ExecutionFailoverDormantIntent,
  type ExecutionFailoverLineageLease,
  type ExecutionFailoverPolicyPort,
  type ExecutionFailoverScope,
  type ExecutionFailoverScopeLifetime,
} from "./methods/model-failover-policy.js";
import type { AgentRuntimeControlApi } from "./agent-runtime-control-api.js";
import type { AgentRuntimeExecutionApi } from "./agent-runtime-execution-api.js";
import {
  closeBrowserSession,
  retainSessionStoreDependentCloseWork,
  drainSessionStoreDependentCloseWork,
  beginShutdown,
} from "./agent-runtime-close.js";

const DEFAULT_BROWSER_SESSION_CLOSE_TIMEOUT_MS = 6_000;

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private failoverModelFactory: AgentRuntimeDeps["modelFactory"];
  private executionFailoverPolicyPort: ExecutionFailoverPolicyPort;
  private executionFailoverScope?: ExecutionFailoverScope;
  private executionFailoverScopeLifetime: ExecutionFailoverScopeLifetime;
  private executionFailoverScopeRetained = false;
  private executionFailoverSelectionSink?: AgentRuntimeDeps["executionFailoverSelectionSink"];
  private executionFailoverState?: ExecutionFailoverState;
  private executionFailoverRevision = 0;
  private executionFailoverMutation: Promise<void> = Promise.resolve();
  private executionFailoverRegistrations = new Map<string, ExecutionFailoverRegistration>();
  private executionFailoverLineageLeases = new Map<string, ExecutionFailoverLineageLease>();
  private executionFailoverDormantIntents = new Map<string, ExecutionFailoverDormantIntent>();
  private browserSessionClosed = false;
  private nodeReplSessionDisposed = false;
  private browserSessionCloseTimeoutMs = DEFAULT_BROWSER_SESSION_CLOSE_TIMEOUT_MS;
  private shutdownStarted = false;
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  private checkoutExecutionPort?: AgentRuntimeDeps["checkoutExecutionPort"];
  private resolveSessionShellSelection?: AgentRuntimeDeps["resolveSessionShellSelection"];
  private sessionShellPreparationRevision = 0;
  /** 模型请求准入端口；随每次模型请求进调用上下文。 */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  private sessionModelSelection: ModelSelection | undefined;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private projectMemoryRecallIndex?: ProjectMemoryRecallIndex;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private pendingSessionStoreDependentCloseWork = new Set<Promise<void>>();
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private subagentPort?: SubagentPort;
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  private branchGeneration = 0;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private videoProcessorPort?: VideoProcessorPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** sendQueuedNow 的 Core 调度权；只活在当前进程，匹配 runtime command 出队即消费。 */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  /** sendQueuedNow reservation；只活在当前 CLI 进程，防 drain/多端重复提升。 */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain：false 时排队输入不自动消费
  // （turn-stop 不续跑、roundtrip 间不 drain），保留成 held 供显式消费。
  private queueAutoDrain = true;
  // 暂停队列恢复后由 CLI 按投影 FIFO 逐项提升。这个窗口内禁止 core 只看当前
  // activeTurn.pendingInputs 做行内 drain，否则新入队消息会越过仍留在投影中的旧暂停项。
  private queueExternalDrainActive = false;
  private shuttingDown = false;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  /** Read-only preflight; accepted input still rechecks source and target in its attach transaction. */
  async validateContextCapsuleReferences(
    references: readonly { kind: "context_capsule"; capsule_id: string }[],
  ): Promise<boolean> {
    return validateContextCapsuleReferences(
      {
        sessionId: this.sessionId,
        sessionStore: this.sessionStore,
        workspaceIdentity: this.config.workspaceIdentity?.toString(),
        workspaceRoot: this.workspaceRoot,
        abortSignal: new AbortController().signal,
      },
      references,
    );
  }

  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2：兼容旧 Host/内部调用传入 legacy，但本版本 Runtime、日志和子 Agent 只使用 preflight。
    this.config = projectPersistentAgentMemoryTools({
      ...config,
      modelContextBudgetStrategy: DEFAULT_LCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    Object.assign(this.config, resolveExecutionState(config));
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.failoverModelFactory = deps.failoverModelFactory ?? deps.modelFactory;
    this.executionFailoverScope = deps.executionFailoverScope;
    this.executionFailoverScopeLifetime = deps.executionFailoverScopeLifetime ?? "turn";
    this.executionFailoverSelectionSink = deps.executionFailoverSelectionSink;
    this.executionFailoverPolicyPort =
      deps.executionFailoverPolicyPort ?? createExecutionFailoverPolicyPort(runtime);
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.checkoutExecutionPort = deps.checkoutExecutionPort;
    this.resolveSessionShellSelection = deps.resolveSessionShellSelection;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    // 旧会话的选择缺失不能阻断历史恢复；不在这里制造默认模型。
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = new Map();
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.videoProcessorPort = deps.videoProcessorPort;
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // GUI「配置」解析子代理模型用的目录（与工具上下文拿的是同一个端口）。
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    this.workspaceRoot = this.workingDirectory;
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(this.contextBuilder, this.rootTraceContext);
      this.contextInitialized = true;
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }
}

export interface AgentRuntime extends AgentRuntimeControlApi, AgentRuntimeExecutionApi {}

// 原 class 方法不可枚举；先装配生命周期方法，保留 prototype 的既有定义顺序。
// 状态仍仅存于同一个 AgentRuntime 实例，不把生命周期 API 变成实例状态。
Object.defineProperties(AgentRuntime.prototype, {
  closeBrowserSession: { configurable: true, value: closeBrowserSession, writable: true },
  retainSessionStoreDependentCloseWork: {
    configurable: true,
    value: retainSessionStoreDependentCloseWork,
    writable: true,
  },
  drainSessionStoreDependentCloseWork: {
    configurable: true,
    value: drainSessionStoreDependentCloseWork,
    writable: true,
  },
  beginShutdown: { configurable: true, value: beginShutdown, writable: true },
});
installAgentRuntimeMethods(AgentRuntime);
