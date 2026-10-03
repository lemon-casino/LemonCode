import type { BackgroundBashOutputResult, SessionDebugSnapshot } from "@lcode/shared";
import type { GitFileMutationJournal } from "@lcode/shared";
/* eslint-disable max-lines -- LCode agent service 接口集中声明 protocol/session/workspace 方法，拆分会增加 service descriptor 迁移成本。 */
import type { Event, IDisposable } from "@lcode/rpc";
import { ServiceChannels } from "@lcode/shared";
import type { AppUsageRange, AppUsageSnapshot, LCodeTaskTokenUsageResult } from "@lcode/shared";
import type { LCodeAutomation, LCodeAutomationRun } from "@lcode/shared";
import type {
  LCodeStorageStartupState,
  LCodeDeliveryKind,
  LCodeAgentMcpServer,
  LCodeBackgroundTurnAttribution,
  TraceId,
  LCodeSessionCompactResult,
  LCodeSessionGoalAction,
  LCodeSessionGoalResult,
  LCodeMessageWithParts,
  ModelSelection,
  LCodeSessionImportHistory,
  LCodePermissionRequestParams,
  AgentLaneResourceSample,
  LCodeMcpTelemetryEvent,
  LCodeMcpResourceSample,
  LCodeToolExecResource,
  LCodeProcessChildProcess,
  LCodeMcpListResult,
  LCodePluginsListResult,
  LCodePluginsOverviewResult,
  LCodePluginsMarketplaceMutationResult,
  LCodePluginsInstallResult,
  LCodePluginsReferenceCatalogResult,
  LCodeSkillsReferenceCatalogResult,
  LCodeWorkflowsDeleteResult,
  LCodeWorkflowsGetResult,
  LCodeWorkflowsListResult,
  LCodeWorkflowsMoveResult,
  LCodeWorkflowsRunsResult,
  LCodeWorkflowsUpdateMetaResult,
  LCodePluginsUninstallResult,
  LCodePluginsRestoreBuiltinResult,
  LCodePluginsConfigureResult,
  LCodePluginsDescribeResult,
  LCodePluginsValidateResult,
  LCodePluginsSetEnabledResult,
  LCodePluginsCancelOperationResult,
  LCodePluginOperationProgressNotification,
  LCodeProviderTestModelConnectivityParams,
  LCodeProviderTestModelConnectivityResult,
  LCodeUserInputRequestParams,
  LCodeUserInputResponse,
  LCodeSessionEvent,
  LCodeSessionInfo,
  LCodeSessionMode,
  LCodeSessionPersistence,
  LCodeSessionSendResult,
  LCodeSessionRequestRuntimePreferencesParams,
  LCodeSessionRuntimePreferencesResult,
  LCodeSessionStateSnapshot,
  LCodeSessionSubagentsResult,
  LCodeStateUpdatedNotification,
  LCodeTaskClientMode,
  LCodeBrowserAmbientContext,
  LCodeWorkspacePresentation,
  LCodeWorkspaceGenerateTextResult,
  LCodeWorkspaceGenerateTextParams,
  LCodeWorkspaceHookTrustGrantResult,
} from "@lcode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@lcode/shared/lcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./lcodeAgentPluginParams.js";
export * from "./lcodeAgentWorkflowParams.js";
import type {
  LCodeAgentAddPluginMarketplaceParams,
  LCodeAgentAutomationIdParams,
  LCodeAgentCancelPluginOperationParams,
  LCodeAgentConfigurePluginParams,
  LCodeAgentResetPluginConfigParams,
  LCodeAgentCreateAutomationParams,
  LCodeAgentDeleteAutomationRunParams,
  LCodeAgentDescribePluginParams,
  LCodeAgentInstallPluginParams,
  LCodeAgentListMcpServerStatusesParams,
  LCodeAgentPluginViewParams,
  LCodeAgentPluginReferenceCatalogParams,
  LCodeAgentSkillReferenceCatalogParams,
  LCodeAgentResolveSuggestedPluginReferenceParams,
  LCodeAgentRemovePluginMarketplaceParams,
  LCodeAgentRestoreBuiltinPluginParams,
  LCodeAgentSetPluginEnabledParams,
  LCodeAgentSetAutomationEnabledParams,
  LCodeAgentUninstallPluginParams,
  LCodeAgentUpdatePluginMarketplaceParams,
  LCodeAgentUpdatePluginParams,
  LCodeAgentUpdateAutomationParams,
  LCodeAgentValidatePluginParams,
  LCodeAgentWorkspaceTarget,
} from "./lcodeAgentPluginParams.js";
import type {
  LCodeAgentDeleteSavedWorkflowParams,
  LCodeAgentGetSavedWorkflowParams,
  LCodeAgentListSavedWorkflowRunsParams,
  LCodeAgentListSavedWorkflowsParams,
  LCodeAgentMoveSavedWorkflowParams,
  LCodeAgentUpdateSavedWorkflowMetaParams,
} from "./lcodeAgentWorkflowParams.js";

export interface LCodeAgentSessionTarget extends LCodeAgentWorkspaceTarget {
  sessionId: string;
}

export interface LCodeAgentResumeSessionParams extends LCodeAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: LCodeAgentMcpServer[];
  // 冷恢复会重建 runtime，工具面隔离必须和 create 保持同一安全边界（CUA 只放行 lcode-cua 工具、
  // 禁 Bash 等）。否则 resume 后模型可见工具面/执行权限会比创建时更宽。
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface LCodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface LCodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface LCodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const LCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "LCODE_AGENT_RUNTIME_UNAVAILABLE";

export type LCodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface LCodeAgentRuntimeLifecycleEvent extends LCodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: LCodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type LCodeAgentCuaPermissionObservation = CuaPermissionObservation &
  LCodeAgentWorkspaceTarget;

export interface LCodeAgentCreateSessionParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: LCodeSessionMode;
  model?: ModelSelection;
  persistence?: LCodeSessionPersistence;
  thoughtLevel?: string;
  /** automation 执行会话关闭模型二次命名，保持首条用户 query 作为稳定标题。 */
  titleGenerationEnabled?: boolean;
  mcpServers?: LCodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: LCodeSessionImportHistory;
}

export interface LCodeAgentListSessionsParams extends LCodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: LCodeAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface LCodeAgentListSessionSubagentsParams extends LCodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** 远程 workspace 的宿主连接身份；只用于选择现有 Host，不进入 CLI wire query。 */
  remoteSessionId?: string;
}

export interface LCodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
}

export interface LCodeAgentTaskTokenUsageParams extends LCodeAgentSessionTarget {}

export interface LCodeAgentReadSessionParams extends LCodeAgentSessionTarget {
  deliveryKind?: LCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** 被动索引/观察者只能读取现有 runtime，禁止为了读快照拉起 session。 */
  runtimePolicy?: LCodeAgentRuntimePolicy;
}

export interface LCodeAgentReadSessionMessagesParams extends LCodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface LCodeAgentReadSessionEventsParams extends LCodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type LCodeAgentReadWorkspacePresentationParams = LCodeAgentWorkspaceTarget;

export interface LCodeAgentGrantWorkspaceHookTrustParams extends LCodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface LCodeAgentSendPromptParamsBase extends LCodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@lcode/shared/lcode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** provider-only 的当前 IAB 状态；UI/session persistence 仍使用 content 原文。 */
  browserAmbientContext?: LCodeBrowserAmbientContext;
  clientMode?: LCodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
}

export type LCodeAgentSendPromptParams = LCodeAgentSendPromptParamsBase &
  LCodeBackgroundTurnAttribution;

export interface LCodeAgentCompactParams extends LCodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface LCodeAgentGoalParams extends LCodeAgentSessionTarget {
  inputId?: string;
  action: LCodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface LCodeAgentSetModelParams extends LCodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface LCodeAgentSetThoughtLevelParams extends LCodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface LCodeAgentSetModeParams extends LCodeAgentSessionTarget {
  mode: LCodeSessionMode;
  expectedRevision?: number;
}

export interface LCodeAgentGenerateWorkspaceTextParams extends LCodeAgentWorkspaceTarget {
  selection: LCodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: LCodeWorkspaceGenerateTextParams["messages"];
  tools?: LCodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * 协议层 RPC 超时。thinking 模型的长请求会超过协议 client 默认的
   * 3 分钟；调用方必须把自身 deadline 透传到这里，否则默认超时先触发、
   * 还会被 onRequestTimeout 误判 stale 杀进程。
   */
  requestTimeoutMs?: number;
}

export interface LCodeAgentTestModelConnectivityParams extends LCodeAgentWorkspaceTarget {
  selection: LCodeProviderTestModelConnectivityParams["selection"];
  mode?: LCodeProviderTestModelConnectivityParams["mode"];
  signal?: AbortSignal;
}

export interface LCodeAgentSessionRuntimePreferencesRequest extends LCodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface LCodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: LCodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface LCodeAgentSessionSubscribeParams extends LCodeAgentSessionTarget {
  deliveryKind: LCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── v4 conversation 通道（竖切）──
// host 只做转发：subscribe/unsubscribe/command 透传给 CLI v4 gateway，
// v4/conversation/frame 通知按 workspace fan-out 给 renderer。

export interface LCodeAgentConversationSubscribeParams extends LCodeAgentSessionTarget {
  /** 水位不变量：仅当客户端真持有该时刻一致状态才允许带。 */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface LCodeAgentConversationUnsubscribeParams extends LCodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: LCodeAgentRuntimePolicy;
}

export interface LCodeAgentConversationResyncParams extends LCodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: LCodeAgentRuntimePolicy;
}

/** 行分页 query（rows/range）：按游标向上取一窗历史行。 */
export interface LCodeAgentConversationRowsRangeParams extends LCodeAgentSessionTarget {
  /** 取 rowId < beforeRowId 的行；缺省 = 从当前尾部向前。 */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** 当前有效分支里的终态 ExitPlanMode 目录。 */
export type LCodeAgentConversationPlansParams = LCodeAgentSessionTarget;

/** workflow run 的事件日志分页（详情页审计面）；cursor = journal sequence。 */
export interface LCodeAgentConversationWorkflowRunEventsParams extends LCodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** dwf run 的枚举（重启后的发现查询）。 */
export interface LCodeAgentConversationWorkflowRunsParams extends LCodeAgentSessionTarget {
  limit?: number;
}

// ── dwf 用户面产物──
// ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给**用户**看的产出（文件 / markdown / 预置看板），
// 不是 run 的顶层返回值（引擎内部对后者的同名叫法）。

/** 产物清单；UI 冷恢复与中枢详情的 durable 读法。 */
export interface LCodeAgentConversationWorkflowRunArtifactsParams extends LCodeAgentSessionTarget {
  runId: string;
}

/** 预置看板的取数面；cursor = journal sequence（严格大于）。 */
export interface LCodeAgentConversationWorkflowRunArtifactDataParams extends LCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** 内容产物的字节，一次一块（≤ 512 KiB，形状逐字照 attachmentRead）。 */
export interface LCodeAgentConversationWorkflowRunArtifactReadParams extends LCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── dwf 工作区 transcript──
/** 轻行清单：一个 run 的 files.* / git.* / world.run 行，不带正文。 */
export interface LCodeAgentConversationWorkflowRunWorkspaceParams extends LCodeAgentSessionTarget {
  runId: string;
}

/** 一个工作区节点的正文，按 maxBytes 保形有界化（缺省与上限在 CLI 网关侧）。 */
export interface LCodeAgentConversationWorkflowRunNodeResultParams extends LCodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface LCodeAgentBackgroundBashOutputParams extends LCodeAgentSessionTarget {
  workId: string;
}

export interface LCodeAgentConversationFileChangesParams extends LCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface LCodeAgentConversationFileRewindPreviewParams extends LCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface LCodeAgentConversationCommandParams extends LCodeAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** 仅 host 内部用于 Browser Use runtime 边界，不进入 v4 wire envelope。 */
  clientMode?: LCodeTaskClientMode;
}

export interface LCodeAgentCommandsQueryParams extends LCodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI 不携带 connectionId；connection scope 以 trusted carrier 注入 wire identity。 */
export interface LCodeAgentAttachmentBeginParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
  draftId?: string;
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface LCodeAgentAttachmentChunkParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
  draftId?: string;
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface LCodeAgentAttachmentTerminalParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
  draftId?: string;
  uploadId: string;
}

export interface LCodeAgentAttachmentReadParams extends LCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface LCodeAgentConversationAttachmentReadParams extends LCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface LCodeAgentConversationAttachmentStatParams extends LCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface LCodeAgentAttachmentPreviewSourceParams extends LCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** host scope 内部 transport 控制面；connectionId 只能经 trusted carrier 注入。 */
export interface LCodeAgentConnectionFlowParams extends LCodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index：workspace 级列表订阅（无 sessionId 维度）。 */
export interface LCodeAgentSessionsIndexSubscribeParams extends LCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * 订阅者作用域后缀：CLI 侧重订阅替换按 (connectionId, topic) 判定，
   * host 进程内多个独立消费者（renderer 侧栏 / task-index syncer）订阅同一 topic 时
   * 必须用不同 connectionId，否则互相替换对方的订阅代际。缺省共享 host 连接 id。
   */
  subscriberScope?: string;
  /**
   * task-list 等被动观察者必须使用 existing-only；runtime 不存在时返回稳定 unavailable，
   * 禁止为了建立列表订阅而启动 Agent。缺省保持显式会话入口的旧行为。
   */
  runtimePolicy?: LCodeAgentRuntimePolicy;
}

/** workspace-config：workspace 级配置目录订阅（config options + slash 目录）。 */
export interface LCodeAgentWorkspaceConfigSubscribeParams extends LCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: LCodeAgentRuntimePolicy;
}

export type LCodeAgentServiceEvent =
  | { type: "session.event"; event: LCodeSessionEvent }
  | { type: "state.updated"; notification: LCodeStateUpdatedNotification }
  | { type: "permission.request"; request: LCodePermissionRequestParams }
  | { type: "userInput.request"; request: LCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: LCodeUserInputResponse;
    }
  | { type: "snapshot"; snapshot: LCodeSessionStateSnapshot };

export interface LCodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface LCodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: LCodeProcessChildProcess[];
}

export interface LCodeAgentStorageStartupSnapshot {
  generation: number;
  state: LCodeStorageStartupState | null;
}

export interface ILCodeAgentService {
  /** 控制面不需要账号或模型，且不发送普通协议请求。 */
  prepareStorage(params: LCodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: LCodeAgentWorkspaceTarget,
  ): Promise<LCodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: LCodeAgentWorkspaceTarget,
  ): Event<LCodeAgentStorageStartupSnapshot>;
  initialize(params: LCodeAgentWorkspaceTarget): Promise<LCodeAgentInitializeResult>;
  /**
   * 同步 App 全局运行时偏好到所有已活动 workspace；不得为此启动空闲 Agent。
   */
  syncAppRuntimePreferences(preferences: LCodeAgentAppRuntimePreferences): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: LCodeAgentWorkspaceTarget,
  ): Promise<LCodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: LCodeAgentCreateSessionParams): Promise<LCodeSessionStateSnapshot>;
  resumeSession(params: LCodeAgentResumeSessionParams): Promise<LCodeSessionStateSnapshot>;
  listSessions(params: LCodeAgentListSessionsParams): Promise<LCodeSessionInfo[]>;
  listSessionSubagents(
    params: LCodeAgentListSessionSubagentsParams,
  ): Promise<LCodeSessionSubagentsResult>;
  getAppUsageStats(params: LCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: LCodeAgentTaskTokenUsageParams): Promise<LCodeTaskTokenUsageResult>;
  readSession(params: LCodeAgentReadSessionParams): Promise<LCodeSessionStateSnapshot>;
  readSessionMessages(
    params: LCodeAgentReadSessionMessagesParams,
  ): Promise<LCodeMessageWithParts[]>;
  readSessionDebug(params: LCodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: LCodeAgentReadSessionEventsParams): Promise<LCodeSessionEvent[]>;
  readWorkspacePresentation(
    params: LCodeAgentReadWorkspacePresentationParams,
  ): Promise<LCodeWorkspacePresentation>;
  /** 无 task/session 的 Settings 预信任；Agent 会重新发现并校验 canonical snapshot。 */
  grantWorkspaceHookTrust(
    params: LCodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<LCodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: LCodeAgentListMcpServerStatusesParams): Promise<LCodeMcpListResult>;
  listPlugins(params: LCodeAgentPluginViewParams): Promise<LCodePluginsListResult>;
  /**
   * Plugin 对话引用 catalog：session-scoped 只读投影。
   * 走 workspace 级 agent client（session 记录只存在于该进程），不走独立插件管理进程。
   */
  getPluginReferenceCatalog(
    params: LCodeAgentPluginReferenceCatalogParams,
  ): Promise<LCodePluginsReferenceCatalogResult>;
  /** Composer Skill 引用 catalog；带 sessionId 时读取该 runtime 的冻结快照。 */
  getSkillReferenceCatalog(
    params: LCodeAgentSkillReferenceCatalogParams,
  ): Promise<LCodeSkillsReferenceCatalogResult>;
  // 已保存工作流的 GUI 中枢：workspace 级、无会话，每次调用现扫 `<cwd>/.lcode/workflows/`。
  // 全局档传 `scope: "global"`：带 workspace 就用它当载体，不带则由 services 层自选本机载体运行时。
  listSavedWorkflows(params: LCodeAgentListSavedWorkflowsParams): Promise<LCodeWorkflowsListResult>;
  getSavedWorkflow(params: LCodeAgentGetSavedWorkflowParams): Promise<LCodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: LCodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<LCodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: LCodeAgentDeleteSavedWorkflowParams,
  ): Promise<LCodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: LCodeAgentListSavedWorkflowRunsParams,
  ): Promise<LCodeWorkflowsRunsResult>;
  // 在项目档 / 全局档之间移动同名文件：
  // `workspace` 是载体（移到项目传目标项目、移到全局传源项目），`to` 是落点档；不覆盖已存在的目标。
  moveSavedWorkflow(params: LCodeAgentMoveSavedWorkflowParams): Promise<LCodeWorkflowsMoveResult>;
  resolveSuggestedPluginReference(
    params: LCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@lcode/shared").LCodePluginsResolveSuggestedReferenceResult>;
  /** 推荐项 Plugin 首次本地检查缺失后的 operation-scoped 刷新进度。 */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<LCodePluginOperationProgressNotification>;
  getPluginsOverview(params: LCodeAgentPluginViewParams): Promise<LCodePluginsOverviewResult>;
  /**
   * 资源管理器：枚举本 Host 内全部本地 Agent 进程（含 plugin / mcp-status 泳道），
   * 并向每个存活 runtime 请求 `process/childProcesses`；单个 runtime 失败只让它的 children 为空。
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<LCodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: LCodeAgentAddPluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: LCodeAgentRemovePluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: LCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<LCodePluginsMarketplaceMutationResult>;
  installPlugin(params: LCodeAgentInstallPluginParams): Promise<LCodePluginsInstallResult>;
  cancelPluginOperation(
    params: LCodeAgentCancelPluginOperationParams,
  ): Promise<LCodePluginsCancelOperationResult>;
  uninstallPlugin(params: LCodeAgentUninstallPluginParams): Promise<LCodePluginsUninstallResult>;
  updatePlugin(params: LCodeAgentUpdatePluginParams): Promise<LCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: LCodeAgentRestoreBuiltinPluginParams,
  ): Promise<LCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: LCodeAgentConfigurePluginParams): Promise<LCodePluginsConfigureResult>;
  resetPluginConfig(
    params: LCodeAgentResetPluginConfigParams,
  ): Promise<LCodePluginsConfigureResult>;
  validatePlugin(params: LCodeAgentValidatePluginParams): Promise<LCodePluginsValidateResult>;
  describePlugin(params: LCodeAgentDescribePluginParams): Promise<LCodePluginsDescribeResult>;
  setPluginEnabled(params: LCodeAgentSetPluginEnabledParams): Promise<LCodePluginsSetEnabledResult>;
  // ---- 定时任务(automation)管理 ----
  listAutomations(params: LCodeAgentWorkspaceTarget): Promise<LCodeAutomation[]>;
  listAllAutomations(): Promise<LCodeAutomation[]>;
  createAutomation(params: LCodeAgentCreateAutomationParams): Promise<LCodeAutomation>;
  updateAutomation(params: LCodeAgentUpdateAutomationParams): Promise<LCodeAutomation | null>;
  deleteAutomation(params: LCodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: LCodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: LCodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: LCodeAgentAutomationIdParams): Promise<LCodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: LCodeAgentAutomationIdParams): Promise<LCodeAutomationRun[]>;
  deleteAutomationRun(params: LCodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: LCodeAgentGenerateWorkspaceTextParams,
  ): Promise<LCodeWorkspaceGenerateTextResult>;
  getWorkspaceFileMutationJournal(
    params: LCodeAgentWorkspaceTarget & { paths: string[] },
  ): Promise<GitFileMutationJournal>;
  testModelConnectivity(
    params: LCodeAgentTestModelConnectivityParams,
  ): Promise<LCodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated：send 主路径已收敛 v4 sendText 命令。仅剩两个消费点——
   * adapter 带附件输入回退（待附件命令面落地后移除）与 lcodeSessionService
   * pass-through；新代码禁止回用。
   */
  sendPrompt(params: LCodeAgentSendPromptParams): Promise<LCodeSessionSendResult>;
  compactSession(params: LCodeAgentCompactParams): Promise<LCodeSessionCompactResult>;
  goalSession(params: LCodeAgentGoalParams): Promise<LCodeSessionGoalResult>;
  closeSession(
    params: LCodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  setModel(params: LCodeAgentSetModelParams): Promise<LCodeSessionStateSnapshot>;
  setThoughtLevel(params: LCodeAgentSetThoughtLevelParams): Promise<LCodeSessionStateSnapshot>;
  setMode(params: LCodeAgentSetModeParams): Promise<LCodeSessionStateSnapshot>;
  respondSessionRuntimePreferences(
    params: LCodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  onDynamicSessionRuntimePreferencesRequest(): Event<LCodeAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI 进程级资源样本，带 services 打的 lane 标签（CLI 自己不知道 lane）。
   * 使用 dynamic event 避免 RPC 服务在无人订阅时缓冲周期事件；
   * 该事件不属于 session/conversation continuous 或 replayable 状态。
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP 进程生命周期与低频内存事件，仅供可信 Host relay 上报 ARMS。 */
  onDynamicMcpTelemetry(): Event<LCodeMcpTelemetryEvent>;
  /** MCP 进程树资源事实，只供可信 Host 汇总上报。 */
  onDynamicMcpResourceSamples(): Event<LCodeMcpResourceSample[]>;
  /** Bash 完成事实，仅可信 Host 资源旁路订阅。 */
  onDynamicToolExecResource(): Event<LCodeToolExecResource>;
  /**
   * @deprecated 旧协议订阅面（session/subscribe + session/event + state.updated）。
   * task-index syncer 已迁 v4 sessions-index/workspace-config 帧；
   * 仅剩 lcodeTaskServiceAdapter.onDynamicTaskEvent（replayable 读路径）消费。
   * 写路径已收敛 v4 命令面；本订阅是读路径投影源。
   */
  onDynamicSessionEvent(params: LCodeAgentSessionSubscribeParams): Event<LCodeAgentServiceEvent>;
  // ── v4 conversation 通道（竖切）──
  /** RPC attachment 建立后先读取 host 可信 hello。 */
  helloConversationV4(): Promise<HelloMessage>;
  /** hello 校验后回送 clientHello；metadata 不能覆盖 connection mode/profile。 */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** 仅供 trusted host relay/facade；terminal RPC caller 必须被 connection scope 拒绝。 */
  setConnectionFlowStateV4(params: LCodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: LCodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: LCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: LCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** rows/range 行分页 query（loadOlder 游标向上补历史）。 */
  conversationRowsRangeV4(
    params: LCodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: LCodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** workflow run 事件日志分页；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunEventsV4(
    params: LCodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** workflow run 枚举；journal-backed 的重启后发现面。 */
  conversationWorkflowRunsV4(
    params: LCodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** workflow run 的用户面产物清单；与 plans 同族（只读、无状态、超时重发安全）。 */
  conversationWorkflowRunArtifactsV4(
    params: LCodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** 预置看板的条目分页；hook 以 itemCount 变化为信号增量拉取。 */
  conversationWorkflowRunArtifactDataV4(
    params: LCodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** 内容产物的字节，一次一块；授权在 CLI 侧（journal 行才是取字节的依据）。 */
  conversationWorkflowRunArtifactReadV4(
    params: LCodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** dwf 工作区 transcript 的清单。 */
  conversationWorkflowRunWorkspaceV4(
    params: LCodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** 一个工作区节点的有界正文。 */
  conversationWorkflowRunNodeResultV4(
    params: LCodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: LCodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: LCodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: LCodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: LCodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: LCodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: LCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: LCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: LCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: LCodeAgentAttachmentTerminalParams): Promise<void>;
  /** Desktop local 已发送视频 source query；远端与 Web 返回 chunked。 */
  attachmentPreviewSourceV4(
    params: LCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** 已发送 image/video 只读分块查询；connection scope 注入可信 workspace 连接。 */
  attachmentReadV4(params: LCodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Share 读取 userInput 附件，允许 text/plain 等非媒体类型。 */
  conversationAttachmentReadV4(
    params: LCodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Share 选择阶段只读 userInput 附件元数据，不读取完整内容。 */
  conversationAttachmentStatV4(
    params: LCodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** workspace 级下行帧流（v4/conversation/frame），renderer 侧按 topic 自行路由。 */
  onDynamicConversationFrame(
    params: LCodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** workspace 级 live telemetry 事实；connection facade 仅向可信 desktop-continuous 下游暴露。 */
  onDynamicLocalTtftFacts(
    params: LCodeAgentWorkspaceTarget,
  ): Event<import("@lcode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: LCodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** 当前窗口全部本地 live task 的 CUA 权限观察；历史、远程与 replayable 不在此事件面。 */
  onDynamicCuaPermissionObservation(): Event<LCodeAgentCuaPermissionObservation>;
  // ── sessions-index 通道（列表活性）──
  subscribeSessionsIndexV4(
    params: LCodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: LCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: LCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 sessions-index 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicSessionsIndexFrame(
    params: LCodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config 通道（配置目录活性；task-index syncer 消费）──
  subscribeWorkspaceConfigV4(
    params: LCodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: LCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: LCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** workspace 级 workspace-config 下行帧流（与 conversation 同一通知，按 topic 前缀分流）。 */
  onDynamicWorkspaceConfigFrame(
    params: LCodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * （CLI 重连重订）：agent 进程换代通知（超时回收/崩溃后重新拉起）。
   * v4 订阅活在 CLI 进程内存，进程换代即失效；订阅方（task-index syncer 等）
   * 收到后必须对该 workspaceKey 重发 subscribe，否则帧流静默中断。
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Agent client 在 service 内完成登记后发布 available，当前 client 关闭后发布 unavailable。
   * 这是被动 observer attach/detach 的唯一生命周期信号，不表达用户使用租约。
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: LCodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** 当前 desktop-local CUA turn 是否仍在执行，用于 Helper recovery 避免中途回收 Agent。 */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: LCodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const ILCodeAgentService = createServiceDescriptor<ILCodeAgentService>(
  ServiceChannels.LCodeAgent,
);
