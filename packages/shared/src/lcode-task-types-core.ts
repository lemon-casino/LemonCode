/* oxlint-disable eslint(max-lines) -- re-home 产物：task 投影承重类型集中迁移，保持单文件契约面。 */
// re-home 迁移产物（为删除旧协议树铺路）。
// 本文件承载旧 task 投影中仍被存活栈消费的明星承重类型：LCodeTaskMeta / LCodeProvider /
// LCodeStreamEvent / TraceId/InputId/QueryId / LCodePersistedMessage(Part) / LCodeTaskSnapshot /
// LCodePlanStep / LCodePermissionRequest 及其依赖闭包（含 realtime 传输基础类型）。
// lcode-task-types.ts / task-realtime.ts 仍保留旧协议兼容面，共用本文件中的核心类型。

import type { LCodeBackgroundTaskControlItem } from "./background-task-controls.js";
import type { ToolCallDisplay } from "./lcode-protocol-v4/toolDisplay.js";
import type {
  LCodeContextUsageBreakdownItem,
  LCodeInteractionRequestOrigin,
  LCodePermissionResponse,
  LCodeSessionActiveTurnKind,
} from "./lcode-protocol-legacy-types.js";
import type { ErrorAttribution } from "./lcode-protocol-v4/snapshot.js";

/**
 * LCode task/session 投影共享类型定义
 *
 * 跨 renderer、host process、LCode agent service 使用的类型。
 */

// ---- 可观测性 ----

/** 全链路追踪 ID，用于日志和观测链路。 */
export type TraceId = string;
/** 每次用户输入的归属 ID，用于 stop/队列/终态收口。 */
export type InputId = string;
/** 每条真实用户 query 的语义归因 ID，用于模型请求 header 和用户问题级观测。 */
export type QueryId = string;
// ---- LCode Provider ----

/** 支持的 LCode agent 提供方；当前仅保留 glm。 */
export type LCodeProvider = "glm";
export type LCodeGlmAgentModelStateUpdateReason =
  | "session_initialized"
  | "model_changed"
  | "thought_level_changed";
export interface LCodeGlmAgentModelStateOption {
  value: string;
  name: string;
}
export interface LCodeGlmAgentModelStateUpdatePayload {
  version: 1;
  sessionId: string;
  reason: LCodeGlmAgentModelStateUpdateReason;
  model: {
    currentValue: string;
  };
  thoughtLevel: {
    enabled: boolean;
    currentValue?: string;
    options: LCodeGlmAgentModelStateOption[];
  };
  contextWindow: {
    tokens: number;
  };
}
/** 外部历史迁移来源。当前只落 Claude Code，后续其它来源继续在这里扩展。 */
export type LCodeTaskMigrationSource = "claudeCode";
export type LCodeTaskGoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type LCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";
export type LCodeTaskTargetChangedSource = "command" | "tool" | "runtime";
export interface LCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: LCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}
export interface LCodeTaskGoalStats {
  /** goal 运行累计秒数；来自 agent 的 session_target 或历史 turn 投影。 */
  timeUsedSeconds: number;
  /** goal 累计 token；优先使用 goal 记账，必要时由 agent 按历史 turn 兜底。 */
  tokensUsed: number;
  /** 用户显式设置的 goal token budget；为空时 UI 可展示 context window。 */
  tokenBudget: number | null;
  /** 当前 session 上下文窗口已使用 token。 */
  contextUsed: number;
  /** 当前 session 上下文窗口容量。 */
  contextWindow: number;
  /** goal 相关历史 tool calls 数。 */
  toolCallCount: number;
  /** 已触发的 goal verifier 生命周期轮次，不等同于普通 runtime turn 或用户继续次数。 */
  iterationCount: number;
}
export interface LCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}
export type LCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";
export interface LCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: LCodeGoalVerificationTimelineStatus;
  verification?: LCodeGoalVerification;
  goalIteration?: number;
  /** verifier divider 应锚定到完成本轮输出的 assistant message，而不是按时间漂移。 */
  anchorAssistantMessageId?: string;
  /** 辅助恢复同一 turn 的边界语义；旧历史可能缺失。 */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}
export interface LCodeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: LCodePlanStep[];
}
export interface LCodeTaskGoalChangedPatch {
  action: LCodeTaskTargetChangedAction;
  source: LCodeTaskTargetChangedSource;
  target: LCodeTaskGoal | null;
  previousTarget?: LCodeTaskGoal | null;
}
// ---- LCode task 模式 ----

export type LCodeTaskMode = "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build";

export type LCodeOffPeakRunType = "init" | "resume";

/** 单个自动输入轮的来源归因；两种后台业务身份禁止同时存在。 */
export type LCodeBackgroundTurnAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: LCodeOffPeakRunType;
      automationId?: never;
    }
  | { automationId?: undefined; offPeakTaskId?: undefined; offPeakRunType?: never };
/** 当前 workspace 下任务的运行时状态 */
export type LCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";
/** 持久化的任务状态，记录最后一次 prompt 的结果 */
export type LCodeTaskPersistStatus = "running" | "completed" | "error";
export interface LCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * 当前 prompt 支持的附件类型。
 * 图片小文件走 agent image block；本地文件/大图片优先走 localPath，让 agent 按自己的阈值读取。
 */
export interface LCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；大图片不再塞进协议正文，由 agent 侧按路径处理。 */
  localPath?: string;
}
export interface LCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** 附件来源；clipboard-text 表示由长文本粘贴落盘生成，agent 只应按临时文件引用处理。 */
  sourceKind?: "clipboard-text";
  /** 旧版/无路径环境的兼容回退；新桌面 GUI 不再为普通文件发送 base64。 */
  dataBase64?: string;
  /** 无本地路径时的小文本回退；有 localPath 时由 agent 自行读取。 */
  textContent?: string;
  localPath?: string;
}
export interface LCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent 已经单独携带 mimeType，所以这里只保留纯 base64 正文。 */
  dataBase64?: string;
  localPath?: string;
}
/** 视频附件：Web 小视频走 dataBase64，桌面端优先 localPath 零拷贝。 */
export interface LCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** 纯 base64 正文；mimeType 由字段单独携带。 */
  dataBase64?: string;
  /** 桌面端真实本地路径；agent 侧按路径读取并做大小校验。 */
  localPath?: string;
}
export interface LCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}
export type LCodePromptAttachment =
  | LCodePromptImageAttachment
  | LCodePromptAudioAttachment
  | LCodePromptVideoAttachment
  | LCodePromptPdfAttachment
  | LCodePromptFileAttachment;
// ---- Task 元数据 ----

export type LCodeTaskInteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface LCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** sessions-index 下发的轻量工具身份；旧摘要缺失时保持兼容。 */
  toolName?: string;
  autoResolution?: LCodeTaskInteractionAutoResolution;
}

export interface LCodeTaskMeta {
  /** UI taskId 与 LCode agent sessionId 保持一致，用于列表选择、日志关联和恢复会话。 */
  taskId: string;
  /** session/任务级观测 traceId，不用于区分单次用户输入 */
  traceId: TraceId;
  /** 任务标题（用户输入或从首条消息截取） */
  title: string;
  /**
   * 用户是否手动覆盖过任务标题。
   *
   * 运行中 agent 仍会继续推送自动生成标题；UI 需要知道当前标题是手动命名，
   * 才能在更新 status/target/updatedAt 时避免把手动标题短暂冲掉。
   */
  titleOverridden?: boolean;
  /** 关联的 workspace 绝对路径 */
  workspacePath: string;
  /**
   * 远程 workspace 的稳定身份（authority + canonicalPath）。
   *
   * 仅按 workspacePath 持久化时，“同路径不同远端主机”会写进同一目录，
   * 导致任务列表、快照和日志互相串读。这里补充 workspaceIdentity 参与隔离。
   */
  workspaceIdentity?: string;
  /** app-owned workspace 分类；缺省为 project，不参与 workspaceKey。 */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: LCodeTaskMode;
  model?: string;
  /**
   * task 级推理强度。
   *
   * active task 内切换 effort 时，如果只写 workspace settings.json，
   * 同一 workspace 的其它 task 会被串改；如果只改 session，下一轮 prompt 又可能被
   * workspace 默认值回推覆盖。这里单独持久化 task-local thoughtLevel，发送前再重放到 session。
   */
  thoughtLevel?: string;
  /**
   * 该 task 最近一次确认与 workspace 运行时基线对齐的 epoch。
   *
   * 过去仅靠 workspacePreferredModel 判断“要不要覆盖当前 task 模型”，
   * 会把“同 supplier 的 task 内模型切换”误当成全局收敛，导致其它 task 被串改。
   * 这里记录 runtimeEpoch，用来区分“task 自身模型保持”与“runtime 基线确实变更后需要收敛”。
   */
  runtimeEpoch?: number;
  /** 创建此 task 时使用的 agent provider，缺省视为 "glm"（旧数据兼容） */
  provider?: LCodeProvider;
  /** 迁移来源；普通新建任务为空，用于识别 Claude Code 原生历史导入。 */
  migrationSource?: LCodeTaskMigrationSource;
  /**
   * cron 身份标记：该 session 属于哪条 automation。
   *
   * cron 身份必须定义在共享的 LCodeTaskMeta 上，供持久化层、V4 UI 和服务契约
   * 共同使用，避免字段已持久化却无法经类型契约访问。
   */
  cronAutomationId?: string;
  /**
   * 闲时任务身份标记：该 session/幻影行属于哪条 off-peak 任务。
   * 与 cronAutomationId 是兄弟标记（闲时不复用 cron 标记）；行 id = 创建时
   * 预分配的 sessionId，标记从创建到运行恒定，供月亮图标与系统分组归属使用。
   */
  offPeakTaskId?: string;
  /** fork 产物保留来源 taskId，供 UI 做本地化标题兜底和后续追溯。 */
  forkedFromTaskId?: string;
  /** 未读任务记录最近一次标记/产生未读的时间，用于跨重启保留蓝点状态。 */
  unreadAt?: number;
  /** 持久化的任务状态，记录最后一次 prompt 的结果 */
  status?: LCodeTaskPersistStatus;
  /** sessions-index 提供的队首阻塞交互摘要，供未打开的后台 task 渲染侧栏状态。 */
  pendingInteraction?: LCodeTaskPendingInteraction;
  /**
   * 最后一次失败的可展示原因。
   *
   * 手机远控断连时实时 task_error 可能无法送达；恢复只能看到 meta.status=error，
   * 但拿不到错误正文，用户会以为发送没有触发。这里把失败原因随 task meta 一起持久化。
   */
  lastError?: LCodeTaskLastError;
  /** 任务级文件改动摘要，仅用于列表/标题展示，真实回滚仍以 fileChanges 为准 */
  changeSummary?: LCodeTaskChangeSummary;
  /** lcode-cli /goal 会话目标；null 表示已显式清空。 */
  target?: LCodeTaskGoal | null;
}
export interface LCodeTaskChangeSummary {
  /** 整个任务里涉及过的唯一文件数 */
  fileCount: number;
  /** 按最终文件结果聚合后的新增行数 */
  added: number;
  /** 按最终文件结果聚合后的删除行数 */
  removed: number;
  /** 任务涉及的文件摘要 */
  files: LCodeTaskChangedFileSummary[];
}
export interface LCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** 同一任务内该文件被写入的总次数 */
  writeCount: number;
  /** 最后一次写入发生在第几轮，后续回滚按钮可直接复用 */
  lastTurnIndex: number;
}
// ---- LCode 配置与命令类型 ----

/** LCode configOptions 的 UI 投影（从 session/new 响应中提取） */
export interface LCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | 自定义 */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** type === "select" 时的选项列表 */
  options?: LCodeConfigSelectValue[];
}
export interface LCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** 值来源：原生模型列表或会话侧注入项（用于 UI 去重与展示控制） */
  origin?: "native" | "injected";
  /** 模型选项所属供应商/分组 id，用于 provider -> model 分组选择 */
  modelProviderId?: string;
  /** 模型选项所属供应商/分组展示名 */
  modelProviderName?: string;
  /** 缺失表示能力未知，空数组表示已知没有可选 reasoning 档位 */
  modelThoughtLevels?: string[];
  /** 模型目录声明的默认 reasoning 档位，不代表用户显式选择 */
  modelDefaultThoughtLevel?: string;
}
export interface LCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** 命令来源；旧协议可能为空，客户端应按 builtin 兼容处理。 */
  source?: "builtin" | "custom";
}
export interface LCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}
// ---- LCode 流式事件（Host → Renderer） ----

export type TaskStreamMirrorableEvent = (
  | LCodeAgentMessageChunk
  | LCodeAgentThoughtChunk
  | LCodeToolCall
  | LCodeToolCallUpdate
  | LCodePlan
  | LCodePermissionRequest
  | LCodeTaskPermissionResponse
  | LCodeElicitationRequest
  | LCodeElicitationResponse
  | LCodeTaskComplete
  | LCodeTaskRunStarted
  | LCodeTaskWarning
  | LCodeTaskError
  | LCodeConfigOptionUpdate
  | LCodeAvailableCommandsUpdate
  | LCodeModeUpdate
  | LCodeSessionInfoUpdate
  | LCodeGoalVerificationUpdate
  | LCodeTaskTokenUsageDelta
  | LCodeTaskNetworkDebugStatus
  | LCodeUsageUpdate
  | LCodeBackgroundTaskControlItemsUpdate
) & { inputId?: InputId };
export type LCodeStreamEvent = (
  | TaskStreamMirrorableEvent
  | LCodeGlmAgentModelStateUpdate
  | LCodeGoalIterationStarted
  | LCodeTurnSteerQueued
  | LCodeTurnSteerStatus
  | TaskStreamMirrorBatch
  | LCodeTaskSnapshotUpdated
) & { inputId?: InputId };
export type LCodeTurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";
export type LCodeTurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export interface LCodeTurnSteerQueued {
  type: "turn_steer_queued";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  pendingInputId: string;
  messageId?: string;
  commandKind?: LCodeTurnSteerCommandKind;
  source?: LCodeTurnSteerSource;
  targetTurnId?: string;
  content: string;
  raw?: unknown;
}
export interface LCodeTurnSteerStatus {
  type: "turn_steer_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryIds?: QueryId[];
  status: "drained" | "discarded" | "rejected";
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  targetTurnId?: string;
  reason?: string;
  raw?: unknown;
}
export interface LCodeAgentMessageChunk {
  type: "agent_message_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上级 toolCallId；null 表示主 agent 正文。 */
  parentToolUseId?: string | null;
  /** agent messageId；LCode synthetic timeline 消息用它做 upsert。 */
  messageId?: string;
  content: string;
  lcodeTimeline?: LCodeTimelineMeta;
}
export interface LCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上级 toolCallId；null 表示主 agent 思考。 */
  parentToolUseId?: string | null;
  content: string;
}
export type LCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";
export type LCodeTimelineTrigger = "manual" | "auto" | "reactive" | "partial" | "session_memory";
export type LCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";
export type LCodeTimelineMeta =
  | LCodeContextCompactionTimelineMeta
  | LCodeGoalVerificationTimelineMeta
  | LCodeSessionForkTimelineMeta;
export interface LCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: LCodeTimelineStatus;
  trigger: LCodeTimelineTrigger;
  display: "separator";
  /**
   * `/compact` 本地会先渲染 optimistic 横条，agent lifecycle 事件稍后才到。
   * 用 inputId 把两者合并，避免同一次压缩先显示“正在压缩”再额外追加一条“已压缩”。
   */
  inputId?: InputId;
  /** 失败后重试需要保留用户原本输入的 `/compact ...` 指令。 */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** compact 阶段用于区分 mid_turn / pre_request 等真实压缩边界，避免 UI 和 e2e 只能按文案猜。 */
  phase?: LCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}
export interface LCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** 纯对话 fork 没有 workspace checkpoint；UI 跳回父消息只依赖 targetMessageId。 */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
export interface LCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** 上级 toolCallId；null 表示主 agent 直接发起的工具调用。 */
  parentToolUseId?: string | null;
  input: unknown;
  /** LCode 固定工具名；新增字段用于把工具身份和历史 kind 分类拆开。 */
  toolName?: string;
  /** 兼容历史分类；当前 LCode 流通常等于 toolName。 */
  kind: string;
  /** agent ToolCall.title，描述当前工具动作的人类可读标题 */
  title: string;
  /** agent ToolCall 原始 payload，调试协议字段时以此为准 */
  raw: unknown;
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface LCodeToolCallUpdate {
  type: "tool_call_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** 上级 toolCallId；null 表示主 agent 直接发起的工具调用。 */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * agent ToolCallUpdate.title，可选；如果 Agent 没更新标题，这里可能为空。
   */
  title?: string;
  /** LCode 固定工具名；ToolCallResult 可能只带 toolId，服务层会从前序调用缓存补齐。 */
  toolName?: string;
  /** 兼容历史分类；当前 LCode 流通常等于 toolName。 */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** agent ToolCallUpdate 原始 payload，调试协议字段时以此为准 */
  raw: unknown;
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface LCodePlan {
  type: "plan";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  steps: LCodePlanStep[];
}
export interface LCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
export interface LCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: LCodePermissionOption[];
  /** V4 permission 是否允许在 Deny 时附带用户反馈。 */
  freeText?: boolean;
  origin?: LCodeInteractionRequestOrigin;
  /**
   * 工具自报的确认预览，复用 tool call row 的 display 投影（同一有界形状）。
   * 缺省 = 纯文本 ask（legacy v3 链路会显式剥离该字段）。
   */
  display?: ToolCallDisplay;
  /** agent RequestPermissionRequest.toolCall 原始 payload */
  raw: unknown;
}
export interface LCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: LCodePermissionResponse;
}
export interface LCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: LCodePermissionResponse;
}
/** LCode Elicitation 请求事件，用于 AskUserQuestion 等需要用户交互的工具 */
export interface LCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: LCodeElicitationOption[];
  multiSelect?: boolean;
  /** AskUserQuestion 的多题结构；存在时 UI 以 tab 形式一次性收集全部答案。 */
  questions?: LCodeElicitationQuestion[];
  /** remote 控制链路同步的当前题号，用于跨端保持 AskUserQuestion 进度。 */
  currentQuestionIndex?: number;
  /** remote 控制链路同步的草稿答案，key 为 answer_0 / answer_1。 */
  answerDrafts?: Record<string, string[]>;
  origin?: LCodeInteractionRequestOrigin;
  /** ElicitationSchema 原始 payload */
  schema?: unknown;
}
/** LCode Elicitation 单个问题 */
export interface LCodeElicitationQuestion {
  question: string;
  header: string;
  options: LCodeElicitationOption[];
  multiSelect?: boolean;
}
/** LCode Elicitation 选项 */
export interface LCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}
/** LCode Elicitation 响应事件 */
export interface LCodeElicitationResponse {
  type: "elicitation_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface LCodeTaskComplete {
  type: "task_complete";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  stopReason: string;
  usage?: LCodeUsage;
}
export interface LCodeTaskRunStarted {
  type: "task_run_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  startedAt: number;
}
export interface LCodeGoalIterationStarted {
  type: "goal_iteration_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  targetId?: string;
  startedAt: number;
}
export interface LCodeTaskError {
  type: "task_error";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  error: string;
  code?: string;
  detail?: string;
  attribution?: ErrorAttribution;
}
export interface LCodeTaskWarning {
  type: "task_warning";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  warning: string;
  code?: string;
  detail?: string;
}
export interface LCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 推理/思考消耗的 token 数；对齐 agent `thoughtTokens`。 */
  reasoningTokens?: number;
  /** 命中缓存的 input token 数 */
  cachedInputTokens?: number;
  /** 写入缓存的 input token 数 */
  cachedWriteInputTokens?: number;
}
export interface LCodeContextCacheUsage {
  /** Provider 上报的最近一次主轮输入 token 数。 */
  inputTokens: number;
  /** Provider 上报的最近一次主轮缓存命中 token 数。 */
  cacheReadTokens: number;
  /** Provider 上报的最近一次主轮缓存写入 token 数。 */
  cacheWriteTokens: number;
  /** 最近一次主轮 provider usage 的缓存命中率；未知时为 null。 */
  latestHitRate?: number | null;
  /** 参与累计平均的主轮请求数量。 */
  hitRateRequestCount?: number;
  /** 参与累计平均的主轮 input token 总量。 */
  totalInputTokens?: number;
  /** 参与累计平均的主轮 cache read token 总量。 */
  totalCacheReadTokens?: number;
  /** 参与累计平均的主轮 cache write token 总量。 */
  totalCacheWriteTokens?: number;
  /** Agent 归一化后返回给 app 的主轮累计平均缓存命中率；未知时为 null。 */
  hitRate: number | null;
}
/** Agent 每次模型请求完成后推送的 task 累计 token 增量。 */
export interface LCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** 稳定去重键，通常来自 LCode Protocol eventId。 */
  eventKey: string;
  eventId?: string;
  querySource?: string;
  usage: LCodeUsage;
}
export type LCodeTaskNetworkDebugStatusType =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";
/** Agent 模型网络状态调试事件；只携带元信息和脱敏 header，不携带 response body/data。 */
export interface LCodeTaskNetworkDebugStatus {
  type: "task_network_debug_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventKey: string;
  eventId?: string;
  statusType: LCodeTaskNetworkDebugStatusType;
  requestId?: string;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  baseURL?: string;
  querySource?: string;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryable?: boolean;
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  reason?: string;
  message?: string;
  timestamp?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
}
// ---- 新增流式事件类型 ----

/** Agent 主动推送配置变更（如 rate limit 降级模型、模式联动变化） */
export interface LCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: LCodeConfigOption[];
}
/** lcode-cli/GLM agent 专属：模型变化后同步思考等级选项和上下文窗口。 */
export interface LCodeGlmAgentModelStateUpdate extends LCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}
/** Agent 推送可用的 slash commands 列表 */
export interface LCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: LCodeSlashCommand[];
}
/** Agent 推送模式变更（如从 architect 自动切到 code） */
export interface LCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: LCodeTaskModeInfo[];
}
/** Agent API 遇到可重试错误时的临时状态；只用于内存 UI，不写入任务持久化。
 * attempt 表示当前正在进行的“第几次重试”，从 1 开始，不是总尝试次数。
 */
export interface LCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}
/** Agent 推送会话标题等元信息更新 */
export interface LCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * 可选的 API 重试状态补丁。
   *
   * `undefined` 表示本次 session_info_update 没有碰这个字段；
   * `null` 表示显式清空重试状态；
   * 对象表示进入/更新重试中。
   */
  apiRetry?: LCodeApiRetryStatus | null;
  /**
   * lcode-cli 通过兼容 session_info_update._meta.lcode.target 投影的 /goal 状态补丁。
   * `undefined` 表示本次没有 target 变化；`target: null` 表示清空。
   */
  target?: LCodeTaskGoalChangedPatch;
}
export interface LCodeGoalVerificationUpdate {
  type: "goal_verification_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  verification: LCodeGoalVerification;
}
/** Agent 推送实时上下文窗口使用情况 */
export interface LCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** 上下文窗口总大小（token 数） */
  size: number;
  /** 当前已使用的 token 数 */
  used: number;
  /** 累计费用 */
  cost?: { amount: number; currency: string } | null;
  /** 当前主轮 provider usage 暴露的缓存命中信息。 */
  cache?: LCodeContextCacheUsage;
  /** Agent 按来源估算的上下文字符量，用于 UI 展示比例，不作为 token 账本。 */
  breakdown?: LCodeContextUsageBreakdownItem[];
}
/** Agent runtime 上报的后台任务控制项；只表示当前 host 内存态，不写入 session 文件。 */
export interface LCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: LCodeBackgroundTaskControlItem[];
}
/** 残余数据 flush 后通知 UI 重新拉取快照，确保迟到的流式数据能被渲染 */
export interface LCodeTaskSnapshotUpdated {
  type: "task_snapshot_updated";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  reason?: TaskRealtimeReason;
  eventId?: string;
  runId?: string;
  streamWatermark?: TaskStreamWatermark;
}
export type LCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable";
export type LCodeTaskRuntimeCommandStatus = "accepted" | "running" | "failed";
export interface LCodeTaskRuntimeCommandBase {
  commandId: string;
  taskId: string;
  traceId: TraceId;
  queryId?: QueryId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  status: LCodeTaskRuntimeCommandStatus;
  createdAt: number;
  updatedAt: number;
  clientId?: string;
  clientLabel?: string;
  error?: string;
}
export interface LCodeTaskSendPromptCommand extends LCodeTaskRuntimeCommandBase {
  type: "send_prompt";
  content: string;
  attachments?: LCodePromptAttachment[];
  /** 定时任务派发的 host command 必须保留 automation 上下文，避免队列 drain 后重新暴露 CronCreate。 */
  automationId?: string;
}
export type LCodeTaskRuntimeCommand = LCodeTaskSendPromptCommand;
export interface TaskStreamMirrorBatch {
  type: "task_stream_mirror_batch";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}
// ---- 持久化格式 ----

export interface LCodeSessionFile {
  meta: LCodeTaskMeta;
  messages: LCodePersistedMessage[];
  /** 文件变更记录，按轮次存储 */
  fileChanges?: LCodePersistedFileChange[];
  /** Git checkpoint 元信息，按轮次存储，仅用于撤销编排 */
  turnCheckpoints?: LCodePersistedTurnCheckpoint[];
}
export interface LCodeSessionRuntimeSnapshot {
  pendingPermissions?: LCodePermissionRequest[];
  pendingElicitations?: LCodeElicitationRequest[];
  /** 当前 session 的 active turn 类型；用于 UI 区分普通 streaming 与 compact 维护态。 */
  activeTurnKind?: LCodeSessionActiveTurnKind;
  /** Agent API 网络重试是运行态提示，只随 snapshot 恢复，不写入 session JSON。 */
  apiRetry?: LCodeApiRetryStatus | null;
  /** LCode Protocol projection 中的上下文窗口用量，用于恢复旧 task UI 的右下角 context meter。 */
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    cache?: LCodeContextCacheUsage;
    breakdown?: LCodeContextUsageBreakdownItem[];
  };
  streamWatermark?: TaskStreamWatermark;
  pendingCommands?: LCodeTaskRuntimeCommand[];
  /**
   * 从 agent session store 的持久 todo 映射出的恢复态。
   * UI 只消费它恢复 todo 面板，不把该字段写回旧 session JSON。
   */
  plan?: LCodePlanStep[] | null;
  /**
   * 目标摘要的运行态投影；从 agent DB / message tool parts 临时计算，不写入 task-index。
   */
  goalStats?: LCodeTaskGoalStats | null;
  goalVerifications?: LCodeGoalVerification[] | null;
  goalVerificationTimeline?: LCodeGoalVerificationTimelineMeta[] | null;
  /**
   * session 历史 TodoWrite 投影出的分组 todo；用于恢复展示，不作为 todo 权威存储。
   */
  todoGroups?: LCodeTodoGroup[] | null;
  /** 兼容字段：承载 host/runtime 运行态后台任务 control，可随 snapshot 恢复，但不持久化到 session JSON。 */
  backgroundBashJobs?: LCodeBackgroundTaskControlItem[];
}
export interface LCodeTaskSnapshotHistory {
  /** 响应态历史窗口是否裁掉了更早消息；只由 getTaskSnapshot 返回，不写入 session JSON。 */
  truncatedBefore: boolean;
  /** 裁剪前可见消息总数，用于 UI 判断是否还能补拉更早历史。 */
  totalMessages: number;
}
export type LCodeTaskSnapshot = LCodeSessionFile & {
  /** 非持久化运行态，只由 getTaskSnapshot 组装返回，禁止写入 session JSON。 */
  runtime?: LCodeSessionRuntimeSnapshot;
  /** 非持久化历史窗口元数据，只描述本次 snapshot 响应是否为尾部窗口。 */
  history?: LCodeTaskSnapshotHistory;
  /** Agent/app 通信返回的可见命令列表；用于恢复 `/` 面板，不写入 session JSON。 */
  slashCommands?: LCodeSlashCommand[];
  /** 从 session settings 投影出的 UI 配置；只随 snapshot 返回，不写入 session JSON。 */
  configOptions?: LCodeConfigOption[];
};
export type LCodeTurnFileState = "applied" | "reverted";
/** 持久化的轮次文件变更 */
export interface LCodePersistedFileChange {
  turnIndex: number;
  snapshots: LCodePersistedFileSnapshot[];
  /** 当前这轮文件变更是否仍应用在 workspace 上 */
  fileState?: LCodeTurnFileState;
}
/** 持久化的轮次文件 checkpoint 元信息 */
export interface LCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** 该轮开始前的文件状态 checkpoint */
  baseFileCheckpointId: string;
  /** 该轮结束后的文件状态 checkpoint；未完成时允许为空 */
  resultFileCheckpointId?: string;
}
/** 持久化的文件快照 */
export interface LCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** 仅用于响应态快照：表示文件快照正文已被首屏预算裁剪，可按 ref 拉取完整内容。 */
  contentRefs?: LCodeTaskSnapshotFileContentRef[];
}
/** 持久化消息的 parts 元素，记录 content / thought / tool-call 的交错顺序。
 *  恢复历史时用它还原 UI 侧的 parts 数组，避免所有文字堆到上面、工具调用排到下面。 */
export type LCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };
export type LCodeAssistantMessageFeedback = "like" | "dislike";
export type LCodeAssistantCheckpointState = "partial";
export type LCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";
export interface LCodePersistedMessage {
  /** 协议侧原始 messageId；用于让实时消息和 snapshot 恢复后的 timeline divider 保持同一身份。 */
  id?: string;
  /** 投影合并 assistant 后保留的原始 messageId 集合，用于 timeline anchor 仍能命中被合并的子消息。 */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** assistant 归属的 legacy goal 展示迭代；仅用于 UI 历史区状态行，不参与 verifier 轮次判定。 */
  goalIteration?: number;
  /** 发送该消息时所归属的模型；历史旧数据缺失时由读取侧回退到 task.meta.model。 */
  model?: string;
  /** 纯文本字符数快照；估算 token 时统一按常量除数换算，后续改口径时可重算。 */
  characterCount?: number;
  /** assistant 历史区最终耗时；仅在本轮结束后落盘，避免历史恢复时再用 timestamp 反推导致时长失真 */
  durationMs?: number;
  /** assistant 是否以用户主动停止或异常中断结束；用于抑制 latest 回复区的提升。 */
  interrupted?: boolean;
  /** 用户对 assistant 回复的本地反馈；仅用于 LCode 展示/统计，不注入 Agent 上下文。 */
  feedback?: LCodeAssistantMessageFeedback;
  attachments?: LCodePromptAttachment[];
  tools?: LCodePersistedToolCall[];
  thought?: string;
  /** 消息各部分的交错顺序，用于历史恢复时保持 content 和 tool-call 的原始排列 */
  parts?: LCodePersistedMessagePart[];
  /** assistant 运行中快照；用于崩溃/重启后恢复到最近一次 parts 边界，不代表本轮自然完成。 */
  checkpointState?: LCodeAssistantCheckpointState;
  checkpointReason?: LCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** 该消息所属的对话轮次，用于关联 per-turn 文件变更摘要和回滚 */
  turnIndex?: number;
  /** 仅用于响应态快照：表示大字段已被首屏预算裁剪，可按 ref 拉取完整正文。 */
  bodyRefs?: LCodeTaskSnapshotBodyRef[];
  /** 仅用于响应态快照：tools 被按条数裁剪时的切片信息，可用于补拉更多工具调用。 */
  toolSlice?: LCodeTaskSnapshotToolSlice;
  /** synthetic divider 元数据（context_compaction / session_fork），随 snapshot 恢复用于 UI 渲染分隔条。 */
  syntheticTimeline?: LCodeTimelineMeta;
}
export type LCodeTaskSnapshotBodyField = "content" | "thought";
export interface LCodeTaskSnapshotBodyRef {
  field: LCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export type LCodeTaskSnapshotToolField = "input" | "output" | "raw";
export type LCodeTaskSnapshotFileContentField = "beforeContent" | "afterContent";
export interface LCodeTaskSnapshotToolFieldRef {
  field: LCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface LCodeTaskSnapshotFileContentRef {
  field: LCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface LCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}
export interface LCodePersistedToolCall {
  /** LCode 固定工具名；旧快照里可能曾把 title 落在这里，读取侧需兼容。 */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** 仅用于响应态快照：表示工具大字段已被首屏预算裁剪，可按 ref 拉取完整内容。 */
  snapshotRefs?: LCodeTaskSnapshotToolFieldRef[];
}
export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // 切模型这类纯配置变更过去混在 task_meta_changed 里广播，UI 无法区分
  // "归属相关 meta 变更（rename/unread）"和"与列表归属无关的配置变更"，
  // 导致每次切模型都触发全局 membership 重拉 + 整表刷新。单独一个 reason 让策略层精确降级。
  | "task_model_changed"
  // 标题更新（首条消息写 title / 收口后自动标题生成）同样与归属无关且高频，
  // 混在 task_meta_changed 里会让每次发送/收口都触发全局 membership 重拉。
  | "task_title_changed"
  | "task_pinned"
  | "task_unpinned"
  | "task_archived"
  | "task_unarchived"
  | "task_deleted"
  | "stream_mirror_gap"
  | "stream_mirror_owner_lost";
export interface TaskStreamMirrorUserMessageOp {
  kind: "user_message";
  messageId: string;
  content: string;
  attachments?: LCodePromptAttachment[];
  timestamp: number;
}
export interface TaskStreamMirrorStreamEventOp {
  kind: "stream_event";
  event: TaskStreamMirrorableEvent;
}
export type TaskStreamMirrorOp =
  | (TaskStreamMirrorUserMessageOp & { seq: number })
  | (TaskStreamMirrorStreamEventOp & { seq: number });
export interface TaskStreamWatermark {
  runId: string;
  opSeq: number;
}
