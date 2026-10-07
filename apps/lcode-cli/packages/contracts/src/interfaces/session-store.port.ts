import type {
  LCodeSessionWorktreeRebindParams,
  LCodeSessionWorktreeRebindResult,
} from "@lcode/shared";
import type { MessageId, PartId, ProjectId, SessionId } from "./shared.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";
import type { CollaborationMode } from "./session.port.js";
import type {
  CreateSessionInput,
  SessionInfo,
  UpdateSessionInput,
  ListSessionsInput,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  SessionRevert,
  FileDiff,
} from "./session-store/session-records.js";
import type {
  ForkChildSessionMetadata,
  ForkCommitBundle,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
} from "./session-store/session-transactions.js";
import type { MessageInfo } from "./session-store/messages.js";
import type {
  MessagePart,
  MessageWithParts,
  ReadSessionTranscriptSnapshotInput,
  ReadSessionTranscriptWindowInput,
  SessionTranscriptSnapshot,
  SessionTranscriptWindow,
} from "./session-store/transcript.js";
import type {
  SessionEntryInfo,
  SessionEntryType,
  SessionInputDelivery,
  SessionInputStatus,
  SessionInputRecord,
} from "./session-store/session-ledger.js";

export interface LocalSettingStorePort {
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

export interface SessionStorePort {
  /**
   * 受信 Host 环境重绑；无 expectedSessionIds 仅校验/查询全部 latest binding。
   * 提交须携带已关闭 resident 的完整查询集合，BEGIN IMMEDIATE 内重读并整批 CAS；
   * 已 new 幂等，scope/ref/集合变化均回滚，禁止调用方选择部分 session。
   */
  worktreeRebind?(
    input: LCodeSessionWorktreeRebindParams & { expectedSessionIds?: readonly string[] },
  ): Promise<LCodeSessionWorktreeRebindResult>;
  /** 受信 Host 的工作树删除维护接口；查询和永久删除均校验绑定及源/执行身份。 */
  worktreeCleanup?(input: {
    executionBindingId: string;
    originWorkspacePath: string;
    originWorkspaceIdentity?: string;
    workspacePath: string;
    workspaceIdentity?: string;
    sessionIds?: string[];
  }): Promise<{ sessionIds: string[] }>;
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  /**
   * Optional bounded, atomic transcript capability. Production SQLite hosts implement this while
   * legacy hosts may retain the messages + getSession compatibility path.
   */
  readTranscriptSnapshot?(
    input: ReadSessionTranscriptSnapshotInput,
  ): Promise<SessionTranscriptSnapshot>;
  /** 原子读取截至锚点的有界最近窗口；缺能力时自动复盘跳过，禁止全量兜底。 */
  readTranscriptWindow?(input: ReadSessionTranscriptWindowInput): Promise<SessionTranscriptWindow>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
    limit?: number;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}

export { SESSION_TASK_TYPES, SESSION_TITLE_SOURCES } from "./session-store/session-records.js";

export type {
  SessionTaskType,
  SessionTitleSource,
  SessionInfo,
  CreateSessionInput,
  UpdateSessionInput,
  FileDiff,
  SessionRevert,
  ListSessionsInput,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
} from "./session-store/session-records.js";

export {
  MESSAGE_VISIBILITIES,
  SYNTHETIC_USER_MESSAGE_SOURCES,
  MESSAGE_ANCHOR_ORIGINS,
} from "./session-store/message-semantics.js";

export type {
  MessageVisibility,
  SyntheticUserMessageSource,
  MessageSemanticsOrigin,
  MessageSemanticsKind,
  MessageSemantics,
  MessageAnchorOrigin,
  StableForkGoalBoundaryMetadata,
  MessageProjectionAnchor,
} from "./session-store/message-semantics.js";

export type {
  OutputFormat,
  MessageSummary,
  MessageContextSnapshot,
  UserMessageInfo,
  AssistantErrorInfo,
  TokenUsageInfo,
  AssistantMessageInfo,
  MessageInfo,
} from "./session-store/messages.js";

export type {
  TextPart,
  ReasoningPart,
  FilePartSource,
  AttachmentStorageMetadata,
  FilePart,
  AgentPart,
  CompactionPart,
  SubtaskPart,
  RetryPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
} from "./session-store/message-content-parts.js";

export type {
  TimelinePartDisplay,
  TimelinePartStatus,
  TimelineModelSelection,
  TimelinePartBase,
  ContextCompactionTimelinePart,
  GoalVerificationTimelinePart,
  SessionForkTimelinePart,
  ModelChangeTimelinePart,
  TimelinePart,
  TimelinePartDraft,
} from "./session-store/message-timeline.js";

export type {
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  ToolState,
  ToolPart,
} from "./session-store/message-tool-parts.js";

export {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
} from "./session-store/transcript.js";

export type {
  SessionTranscriptSnapshotLimits,
  ReadSessionTranscriptSnapshotInput,
  ReadSessionTranscriptWindowInput,
  SessionTranscriptSnapshot,
  SessionTranscriptWindow,
  MessagePart,
  MessageWithParts,
} from "./session-store/transcript.js";

export type {
  StableForkTargetMetadata,
  ForkChildSessionMetadata,
  ForkCommandResult,
  ForkCommitBundle,
  SharedContextImportCommitBundle,
  SharedContextImportStatus,
  SharedContextImportTransition,
} from "./session-store/session-transactions.js";

export {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_TYPES,
} from "./session-store/session-ledger.js";

export type {
  SessionEntryType,
  SessionEntryInfo,
  SessionInputDelivery,
  SessionInputStatus,
  SessionInputRecord,
} from "./session-store/session-ledger.js";

export type {
  UsageQuerySource,
  UsageStatus,
  ModelUsageRecord,
  TurnUsageRecord,
  ToolUsageRecord,
  AppUsageQueryInput,
  AppUsageTotalsRow,
  AppUsageTurnTotalsRow,
  AppUsageToolTotalsRow,
  AppUsageModelRow,
  AppUsageToolRow,
  AppUsageDayRow,
  AppUsageDayModelRow,
  AppUsageQueryResult,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  UsageStorePort,
} from "./session-store/usage.js";
