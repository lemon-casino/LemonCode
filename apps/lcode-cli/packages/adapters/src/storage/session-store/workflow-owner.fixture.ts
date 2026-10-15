import { createSqliteSessionStore } from "../index.js";
import type { WorkflowJournalOwnerLease } from "@lcode/dynamic-workflow";

const store = createSqliteSessionStore({ dbPath: process.argv[2] });
let lease: WorkflowJournalOwnerLease | undefined;
process.on("message", async (message: { action: "claim" | "release" | "write" }) => {
  try {
    if (message.action === "claim")
      lease = await store.acquireWorkflowExecutionOwner({
        parentSessionId: "parent",
        workspaceKey: "fixture-identity",
      });
    else if (message.action === "release") lease?.release();
    else lease?.journal.updateRunUsage("live", 7);
    process.send?.({ ok: true, generation: lease?.generation });
  } catch (error) {
    process.send?.({ ok: false, code: (error as { code?: string }).code });
  }
});
process.on("disconnect", () => {
  store.close();
  process.exit(0);
});
process.send?.({ ready: true });
