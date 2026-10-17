export const projectExecutionSetModule = {
  id: "project-execution-set",
  requires: ["shared", "services", "worktree", "rpc"],
  provides: ["project-execution-set-service"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
