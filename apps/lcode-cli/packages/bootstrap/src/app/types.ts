import type { BackgroundBashOutputResult } from "@lcode/shared";
import type {
  AgentRuntime,
  ResumeSessionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceForkResult,
  WorkspaceGenerateTextInput,
} from "@lcode/core";
import type { LCodeModelOption } from "@lcode/shared";
import type {
  BackgroundTaskCancelResult,
  CollaborationMode,
  GoalStatus,
  InputHistoryEntry,
  InputHistoryKind,
  McpServerStatus,
  ModelSelection,
  PluginLoadOutcome,
  PluginReferenceCatalog,
  SessionGoal,
  SessionId,
  SkillLoadOutcome,
  ToolArtifactReadResult,
  TodoItem,
  TraceContext,
  TurnSteerResult,
  TurnInputIntentMetadata,
  ModelUsage,
  ModelToolCall,
  SupportedLocale,
  UiLocale,
  UiThemePreference,
} from "@lcode/contracts";
import type { SessionTranscriptMessage } from "../session-transcript.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type {
  RespondWorkspaceHookReviewInput,
  ToggleWorkspaceHookReviewItemInput,
  RevokeWorkspaceHookTrustInput,
  SubmitPromptOptions,
  SteerTurnOptions,
  SendInputOptions,
  PromptInput,
  SendInputResult,
  ResumeOptions,
  LCodePluginSetResult,
  LCodePluginUninstallResult,
  SetLocaleResult,
} from "./app-options.js";
import type { LCodeAppWorkflow } from "./app-workflow-types.js";

export type {
  WorkspaceHookReviewHostContext,
  RespondWorkspaceHookReviewInput,
  ToggleWorkspaceHookReviewItemInput,
  RevokeWorkspaceHookTrustInput,
  LCodeAppRuntimeConfigInput,
  LCodeAppOptions,
  SubmitPromptOptionsBase,
  SubmitPromptOptions,
  PrepareUserExecutionBoundary,
  SteerTurnOptions,
  SendInputOptions,
  UserPromptInput,
  PromptInput,
  SendInputResult,
  ResumeOptions,
  LCodePluginSetResult,
  LCodePluginUninstallResult,
  SetLocaleResult,
  ResolveLatestSessionOptions,
  RunLCodeProtocolAgentOptions,
  ListLCodeSessionsOptions,
} from "./app-options.js";
export type { LCodeModelOption } from "@lcode/shared";
export type { WorkflowAgentRunner } from "@lcode/core";

export interface LCodeApp extends LCodeAppWorkflow {
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly runtime: AgentRuntime;
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * Trust store 落盘后本 session 的 coordinator
   * 内存镜像不会自动更新（per-session，仅创建时 load 一次）。Settings 无 task 的
   * pretrust 授权成功后，server 会按 workspace 逐个调用本方法，把文件重载进
   * coordinator 并重发 admission 状态，否则已信任 Hook 继续被拒、banner 不刷新。
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** current-only 协议快照精确读取当前 Registry 模型，避免枚举整个目录。 */
  getCurrentModelOption?(): LCodeModelOption | undefined;
  /** 只读 Registry 元数据；不要求选项完整，也不绑定执行模型。 */
  getModelOption?(selection: ModelSelection): LCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@lcode/shared").LCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** chunk transaction commit 后把完整二进制原子寄存到 session artifact store。 */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** 已发送 image/video 预览：在拥有 session 的 runtime 内读取 artifact 或实际路径。 */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段只读 userInput 附件元数据；不读取完整内容。 */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频：解析 artifact-first 本地播放源；否则保持分片读取。 */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** 用户提交的原始 goal 命令；target 仍只存 objective，聊天行按该文本展示。 */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    acceptance?: import("@lcode/contracts").GoalAcceptance;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;
  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;
  clearTarget(): Promise<boolean>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): LCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  setPluginEnabled(plugin: string, enabled: boolean): Promise<LCodePluginSetResult>;
  uninstallPlugin(plugin: string): Promise<LCodePluginUninstallResult>;
  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 在 App 创建时由 resolveStartupPlugins 结果构建一次，之后只读；
   * `plugins/referenceCatalog` 带 sessionId 时以此为 session authority。
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** 当前 Session 的 AgentRuntime Skill 发现快照；冷恢复重建 runtime 后重新发现。 */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkFromCheckpoint(options?: {
    targetCheckpointId?: string;
    targetMessageId?: string;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection; mode?: "temporary" },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;
  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;
  setModelIoFullRetentionEnabled?(enabled: boolean): void;
  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * per-turn（off-peak idle plan）：true = 仅切运行态——不写磁盘模型选择、
       * 不产出 modelChange 聊天通知。用于 turn 级临时切换（应用/还原成对出现）。
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;
  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;
  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
  /**
   * v4 deferred queue：busy 但没有 steerable active turn（compact / goal verifier /
   * goal continuation 边界）时，普通输入必须先落 TurnSteerQueued，不能因
   * runtime.steerTurn(no_active_turn/turn_not_steerable) 从 composer 消失。
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除一条排队输入。返回是否命中。 */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** sendQueuedNow 原子提升：reserve 后普通 drain/delete 不得消费该项。 */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。返回是否命中。 */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend：清空全部排队输入，返回丢弃条数。 */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置）。 */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列已由 CLI 外层消费到空：恢复 core 对后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级配置）。 */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  submitPrompt(prompt: PromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
}
