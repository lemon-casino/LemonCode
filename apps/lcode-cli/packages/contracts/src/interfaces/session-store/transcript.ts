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
