import type { GitChangeSourceId } from "@lcode/shared";
import type { TurnHeaderRow } from "@lcode/shared/lcode-protocol-v4";

/** 来自具体聊天摘要的只读定位请求；不是提交范围或可写会话状态。 */
export interface GitTurnReviewRequest {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  header: TurnHeaderRow;
  logEpoch: string;
}

export type OpenGitReview = (sourceId?: GitChangeSourceId, turn?: GitTurnReviewRequest) => void;
