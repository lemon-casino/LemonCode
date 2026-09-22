import type {
  ActorRecord,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunStatus,
  RunStopReason,
  WorkflowErrorJson,
} from "./types.js";

/** Monotonic journal sequence; production journals also stamp the append time. */
export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  timeCreated?: number;
}

export interface ListEventsOptions {
  afterSequence?: number;
  limit?: number;
}

/** Status and result are committed together so a completed run never loses its artifact. */
export interface RunSettlementRecord {
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

/** Synchronous durable journal; readers use cursor-based pagination for events. */
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  updateRunUsage(runId: string, spentTokens: number): void;

  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string): ActorRecord[];

  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined;
  listNodes(runId: string): NodeRecord[];

  appendEvent(runId: string, event: RunEvent): StoredEvent;
  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[];
}
