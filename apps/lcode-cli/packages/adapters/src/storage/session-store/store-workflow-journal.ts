import type { JournalStorePort } from "@lcode/dynamic-workflow";
import type { SqliteStoreAccess } from "./store-access.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import { acquireWorkflowJournalOwner } from "./repositories/workflow-journal-owner.js";

// 同一 Store 的唯一 journal 视图缓存；弱引用不延长原 Store 生命周期。
const journals = new WeakMap<SqliteStoreAccess, JournalStorePort>();
export const workflowJournalMethods = {
  workflowJournalStore(this: SqliteStoreAccess): JournalStorePort {
    let journal = journals.get(this);
    if (!journal) {
      journal = createDwfJournalStore(this.db);
      journals.set(this, journal);
    }
    return journal;
  },
  acquireWorkflowExecutionOwner(
    this: SqliteStoreAccess,
    input: { parentSessionId: string; workspaceKey: string },
  ) {
    return acquireWorkflowJournalOwner({
      ...input,
      db: this.db,
      journal: workflowJournalMethods.workflowJournalStore.call(this),
    });
  },
};
