import type {
  AskUserQuestionAnnotation,
  AskUserQuestionInput,
  McpServerStatus,
  ModelUsageSummary,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  TodoItem,
} from "@lcode/contracts";
import type {
  TuiClipboardImage,
  TuiOptions,
  TuiSelection,
  TuiSelectionInput,
  TuiSelectionPending,
} from "./types.js";
import type { ModifiedFileStat } from "./app-modified-files.js";
export type { ModifiedFileStat } from "./app-modified-files.js";

export type Message = {
  content: string;
  id?: string;
  parts?: TranscriptPart[];
  role: "agent" | "system" | "timeline" | "user";
  streamProjected?: boolean;
  streaming?: boolean;
  timeline?: TimelineMessage;
};

export type TranscriptPart = TextTranscriptPart | ThoughtTranscriptPart | ToolTranscriptPart;

export type TimelineMessage = {
  attempt?: number;
  command?: string;
  maxAttempts?: number;
  messageId?: string;
  operationId: string;
  reason?: string;
  status: "started" | "retrying" | "skipped" | "completed" | "failed" | "interrupted";
  trigger?: string;
  type: "context_compaction";
};

export type TuiTextFormat = "markdown" | "plain";

export type TextTranscriptPart = {
  format?: TuiTextFormat;
  streamProjected?: boolean;
  text: string;
  type: "text";
};

export type ThoughtTranscriptPart = {
  contentCharCount: number;
  status: "thinking" | "thought";
  streamProjected?: boolean;
  text: string;
  type: "thought";
};

export type ToolTranscriptPart = {
  detailLines: string[];
  error?: string;
  output?: string;
  resultDisplay?: ToolResultDisplay;
  status: "pending" | "running" | "completed" | "failed";
  title?: string;
  toolCallId: string;
  toolName: string;
  type: "tool";
};

export type ToolResultDisplay = {
  diff?: string;
  filePath?: string;
  filetype?: string;
  lines: ToolResultDisplayLine[];
  structuredPatch?: ToolResultDisplayHunk[];
  title?: string;
  truncated?: boolean;
};

export type ToolResultDisplayLine = {
  text: string;
  tone: "addition" | "context" | "deletion" | "meta";
};

export type ToolResultDisplayHunk = {
  lines: string[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
};

export type DraftImageAttachment = {
  dataUrl: string;
  id: number;
  mediaType: TuiClipboardImage["mediaType"];
  placeholder: string;
  sizeBytes?: number;
  type: "image";
};

export type DraftFileAttachment = {
  id: number;
  path: string;
  placeholder: string;
  type: "file";
};

export type DraftAttachment = DraftFileAttachment | DraftImageAttachment;

export type QueuedInput = {
  id: string;
  text: string;
};

export type ApprovalDecision = "allow_once" | "allow_project" | "deny";

export type QuestionPromptState = {
  annotations: Record<string, AskUserQuestionAnnotation>;
  answers: Record<string, string>;
  currentQuestionIndex: number;
  editingOther: boolean;
  input: AskUserQuestionInput;
  multiSelections: Record<string, string[]>;
  otherBuffer: string;
  otherText: Record<string, string>;
  reviewing: boolean;
  selectedOptionIndex: number;
};

export type ApprovalPrompt = {
  cleanup: () => void;
  questionState?: QuestionPromptState;
  reject: (error: Error) => void;
  request: PermissionBrokerRequest;
  resolve: (result: PermissionBrokerResult) => void;
  selectedDecision: ApprovalDecision;
};

export type ActiveSelectionPending = TuiSelectionPending & {
  command: string;
  itemId: string;
};

export type ActiveSelectionInput = TuiSelectionInput & {
  command: string;
  itemId: string;
  value: string;
};

export type SelectionState = TuiSelection & {
  filter: string;
  input?: ActiveSelectionInput;
  pending?: ActiveSelectionPending;
  selectedIndex: number;
};

export type SubmitValueOptions = {
  abortStatus?: string;
  preserveSelection?: boolean;
};

export type SlashCommand = NonNullable<TuiOptions["slashCommands"]>[number];

export type SlashSelectionState = {
  selectedIndex: number;
};

export type EffortCommandSelectionState = {
  selectedIndex: number;
};

export type ModelCommandSelectionState = {
  selectedIndex: number;
};

export type ModeCommandSelectionState = {
  selectedIndex: number;
};

export type NetworkRequest = {
  attempt?: number;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  id: string;
  method: string;
  model?: string;
  provider?: string;
  requestId: string;
  source: string;
  startedAt: string;
  status: "pending" | "complete" | "error";
  statusCode?: number;
  updatedAt: string;
  url: string;
};

export type ContextUsage = {
  contextUsed?: number;
  contextWindow?: number;
};

export type CacheStats = {
  cachedMessages?: number;
  cacheReadTokens?: number;
  lastCacheHit?: boolean;
  totalMessages?: number;
};

export type McpSidebarState = {
  error?: string;
  loading: boolean;
  servers: Record<string, McpServerStatus>;
};

export type SidebarState = {
  activeTurnId?: string;
  busy: boolean;
  cacheStats?: CacheStats;
  contextUsage: ContextUsage;
  draft: string;
  lastError?: string;
  lastEvent: string;
  messageCount: number;
  mode: string;
  mcpStatus?: McpSidebarState;
  model: string;
  modifiedFiles: ModifiedFileStat[];
  networkRequests: NetworkRequest[];
  status: string;
  statusDetails: string[];
  thoughtLevel: string;
  todos: TodoItem[];
  traceId?: string;
  usage?: ModelUsageSummary;
  workspaceGitBranch?: string;
  workspaceDirectory?: string;
};

export { palette } from "./theme/index.js";

export const approvalDecisions: ApprovalDecision[] = ["allow_once", "allow_project", "deny"];
