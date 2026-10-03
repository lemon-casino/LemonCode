export const worktreeModule = {
  id: "worktree",
  requires: ["shared", "services"],
  provides: ["worktree-service", "checkout-coordinator"],
  publicEntrypoints: ["contract.ts", "node.ts"],
} as const;
