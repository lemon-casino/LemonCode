export type PipSessionEvent =
  | {
      kind: "turn-started";
      sessionId: string;
      turnId: string;
      sequenceNumber?: number;
      eventId?: string;
    }
  | {
      kind: "focus-changed";
      sessionId: string | null;
      revision: number;
      sourceWindowId: string;
      sequenceNumber?: number;
      eventId?: string;
    }
  | {
      kind: "turn-ended" | "turn-completed" | "turn-failed";
      sessionId: string;
      turnId: string;
      sequenceNumber?: number;
      eventId?: string;
      outcome?: "completed" | "failed";
    }
  | {
      kind: "tool-scheduled" | "tool-started";
      sessionId: string;
      turnId: string;
      toolCallId: string;
      sequenceNumber?: number;
      eventId?: string;
    }
  | {
      kind: "session-closed";
      sessionId: string;
      turnId?: string;
      sequenceNumber?: number;
      eventId?: string;
    };

export interface PipSessionSnapshot {
  turns: Array<Extract<PipSessionEvent, { kind: "turn-started" }>>;
  focus?: Extract<PipSessionEvent, { kind: "focus-changed" }>;
}
