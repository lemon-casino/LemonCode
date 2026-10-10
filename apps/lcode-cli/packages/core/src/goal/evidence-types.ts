import type { FileSystemPort, SessionStorePort, SessionGoal, SessionId, GoalRequirement, GoalEvidenceAttempt } from "@lcode/contracts";

export interface GoalEvidenceOwner {
  sessionId: SessionId;
  workspacePath: string;
  workspaceKey: string;
  fileSystem?: FileSystemPort;
  store?: SessionStorePort;
}
export interface GoalExecution {
  executionId: string;
  source: "Bash" | "world.run";
  command: string;
  args?: readonly string[];
  startedAt: number;
}
export interface GoalExecutionCapture {
  owner: GoalEvidenceOwner;
  goal: SessionGoal;
  execution: GoalExecution;
  bindingHash: string;
  attempt: GoalEvidenceAttempt;
  requirements: { requirement: GoalRequirement; before: string | null }[];
}

