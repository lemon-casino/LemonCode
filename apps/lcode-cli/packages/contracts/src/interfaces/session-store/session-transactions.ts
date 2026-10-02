import type { SessionId } from "../shared.js";
import type { SessionGoal, GoalStatus } from "../../tools/target.js";
import type { CreateSessionInput } from "./session-records.js";
import type { MessageWithParts } from "./transcript.js";
import type { SessionEntryInfo, SessionInputDelivery } from "./session-ledger.js";

/** V4 stable fork resolver 固定的目标 product turn segment。 */
export interface StableForkTargetMetadata {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

/** 与 child session 同事务落盘的命令幂等事实。 */
export interface ForkChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string;
  forkTarget: StableForkTargetMetadata;
}

export type ForkCommandResult =
  | { type: "forkAssistant"; sessionId: string }
  | { type: "createSelectionSideSession"; sessionId: string }
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * conversation fork 的唯一原子提交载荷。core 在内存完成 remap；adapter 不参与业务裁决，
 * 只保证 child/copy/goal/entries/input/parent command fact 全有或全无。
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** 存储复制来源（目标 ID -> 父记录 ID）；只保留旧磁盘快照，不参与模型选择。 */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}
