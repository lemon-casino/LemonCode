import type { SessionId } from "./shared.js";

export interface SessionMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  content: string;
  createdAt: string;
}

export interface SessionMailboxPort {
  drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;
}
