import type { MessageId, SessionId } from "../shared.js";
import type { SessionInfo } from "./session-records.js";
import type {
  TextPart,
  ReasoningPart,
  FilePart,
  AgentPart,
  CompactionPart,
  SubtaskPart,
  RetryPart,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
} from "./message-content-parts.js";
import type { TimelinePart } from "./message-timeline.js";
import type { ToolPart } from "./message-tool-parts.js";
import type { MessageInfo } from "./messages.js";

export const SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS = 256;

export const SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS = 1_024;

export const SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES = 262_144;

export interface SessionTranscriptSnapshotLimits {
  maxMessageRows: number;
  maxPartRows: number;
  /** Combined UTF-8 bytes of admitted message/part JSON data columns. */
  maxDataBytes: number;
}

export interface ReadSessionTranscriptSnapshotInput {
  sessionID: SessionId;
  limits: SessionTranscriptSnapshotLimits;
}

export interface SessionTranscriptSnapshot {
  session: SessionInfo | null;
  messages: MessageWithParts[];
  loadedMessageCount: number;
  loadedPartCount: number;
  /** 原始message/part JSON数据列字节，不含读取时注入的行ID和外层容器。 */
  loadedDataBytes: number;
  truncated: boolean;
}

/** 最近窗口包含指定锚点，不读取其后的消息；沿用 snapshot 的硬上限。 */
export interface ReadSessionTranscriptWindowInput extends ReadSessionTranscriptSnapshotInput {
  throughMessageID: MessageId;
}

export interface SessionTranscriptWindow extends SessionTranscriptSnapshot {
  throughMessageID: MessageId;
  /** 锚点必须属于当前 session；不存在时 messages 为空，不能退回旧 prefix。 */
  boundaryFound: boolean;
  /** 仅省略更早历史，不代表窗口内部缺失材料。 */
  prefixTruncated: boolean;
  /**
   * 同一读取快照证明当前session的cut严格早于最早完整入窗消息。
   * 只比较存储顺序列，不额外读取正文；旧adapter缺席时调用方保持fail-closed。
   */
  branchCutBeforeWindow?: { messageID: MessageId; branchGeneration?: number };
  /** 选定窗口内部的消息、parts 或 JSON 字节未完整载入。 */
  truncated: boolean;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}
