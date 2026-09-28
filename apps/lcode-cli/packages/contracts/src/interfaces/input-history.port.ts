import type { InputHistoryId, ProjectId, SessionId } from "./shared.js";

export type InputHistoryKind = "prompt" | "steered_input" | "slash_command";

export interface InputHistoryAttachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
}

export interface InputHistoryEntry {
  id: InputHistoryId;
  projectID: ProjectId;
  sessionID?: SessionId;
  text: string;
  attachments?: InputHistoryAttachment[];
  kind: InputHistoryKind;
  time: {
    created: number;
  };
}

export interface RecordInputHistoryInput {
  projectID: ProjectId;
  sessionID?: SessionId;
  text: string;
  attachments?: InputHistoryAttachment[];
  kind: InputHistoryKind;
  time?: {
    created?: number;
  };
}

export interface RecallPreviousInputHistoryInput {
  projectID: ProjectId;
  skip?: number;
}

export interface InputHistoryStorePort {
  recordInputHistory(input: RecordInputHistoryInput): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(
    input: RecallPreviousInputHistoryInput,
  ): Promise<InputHistoryEntry | null>;
}
