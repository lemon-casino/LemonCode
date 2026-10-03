import type { MessageId, PartId, ProjectId, SessionId, TraceId, WorkspaceId } from "../shared.js";
import type { PermissionRuleset } from "../permission.port.js";
import type { SessionEntryInfo } from "./session-ledger.js";

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "worktree_repair",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;

export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;

export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export interface SessionInfo {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  summaryDiffs?: FileDiff[];
  revert?: SessionRevert;
  permission?: PermissionRuleset;
  time: {
    created: number;
    updated: number;
    titleUpdated?: number;
    compacting?: number;
    archived?: number;
  };
}

export interface CreateSessionInput {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType?: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  permission?: PermissionRuleset;
  /** 与 session 行同事务写入；绑定引用不能在崩溃后与执行路径脱离。 */
  initialEntries?: SessionEntryInfo[];
  time?: {
    created?: number;
    updated?: number;
  };
}

export interface UpdateSessionInput {
  id: SessionId;
  directory?: string;
  path?: string | null;
  timeUpdated?: number;
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: readonly SessionTitleSource[];
  shareURL?: string | null;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs?: FileDiff[];
  } | null;
  revert?: SessionRevert | null;
  permission?: PermissionRuleset | null;
  timeCompacting?: number | null;
  timeArchived?: number | null;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
  newPath?: string;
}

export interface SessionRevert {
  messageID: MessageId;
  partID?: PartId;
  snapshot?: string;
  diff?: string;
  kind?: "conversation_rewind";
  scope?: "conversation" | "workspace" | "both";
  targetMessageID?: MessageId;
  createdMessageID?: MessageId;
  keptMessageIDs?: MessageId[];
  /**
   * append-only conversation branch 的 cut 游标：本次 rewind 提交前最后一条持久消息。
   * active branch = keptMessageIDs + 该消息之后新追加的消息。旧 createdMessageID 仅用于兼容。
   */
  branchCutAfterMessageID?: MessageId;
  /** 每次 destructive conversation rewind 单调递增，用于隔离旧分支异步结果。 */
  branchGeneration?: number;
}

export interface ListSessionsInput {
  /** 原项目列表包含已绑定工作树的会话；仅用于展示，执行路径不会改写。 */
  includeWorktreeOrigins?: boolean;
  projectID?: ProjectId;
  /** undefined = 不按 identity 过滤；null = 仅本地/legacy 空 identity；字符串 = 精确 workspace identity。 */
  workspaceID?: WorkspaceId | null;
  directory?: string;
  path?: string;
  roots?: boolean;
  taskTypes?: SessionTaskType[];
  includeArchived?: boolean;
  limit?: number;
}

export interface ClaimLegacySessionWorkspaceInput {
  sessionIDs: SessionId[];
  directory: string;
  workspaceID: WorkspaceId;
}

export interface RepairLegacyRemoteSessionWorkspaceInput {
  sessionID: SessionId;
  projectID: ProjectId;
  legacyWorkspaceDirectory: string;
  workspaceID: WorkspaceId;
  workspacePath: string;
}

export interface RepairRemoteSessionPathsInput {
  sessionID: SessionId;
  workspaceID: WorkspaceId;
  expectedDirectory: string;
  expectedPath: string | null;
  directory: string;
  path: string | null;
  timeUpdated: number;
}
