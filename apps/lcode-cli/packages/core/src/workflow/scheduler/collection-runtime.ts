import { WorkflowSchedulerEventLog } from "./events.js";
import type { WorkflowGraphSchedulerDeps } from "./types.js";

export interface WorkflowCollectionPlannerRuntime {
  createActivityId: () => string;
  eventLog: WorkflowSchedulerEventLog;
  plannerRunner?: WorkflowGraphSchedulerDeps["plannerRunner"];
  writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];
}
