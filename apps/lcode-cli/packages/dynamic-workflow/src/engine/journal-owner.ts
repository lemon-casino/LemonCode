import type { JournalStorePort } from "./journal-types.js";
import type { RunStatus, RunSettlementRecord } from "./types.js";

/** 宿主执行 lease；观察者不能通过读 journal 获得写入权。 */
export interface WorkflowJournalOwnerLease {
  readonly journal: JournalStorePort;
  readonly generation: number;
  assertOwned(): void;
  reconcileInterrupted(
    runId: string,
    expected: RunStatus,
    settlement: RunSettlementRecord,
  ): boolean;
  release(): void;
}
