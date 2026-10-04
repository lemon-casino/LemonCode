export function createWorktreeBranchFixture(
  calls: { method: string; params: unknown }[],
  failBranches: () => boolean,
  managed?: () => { name: string; checkoutPath: string | null },
) {
  const deleted = new Set<string>();
  const query = new URLSearchParams(location.search);
  const branchNames = query.has("occupiedBranch")
    ? ["L-GO", managed!().name, "external"]
    : query.has("longBranches")
      ? [
          "L-GO",
          "occupied",
          `lcode/task-${"中文English功能".repeat(12)}`,
          ...Array.from({ length: 30 }, (_, index) => `lcode/task-列表末尾功能-${index}`),
        ]
      : ["L-GO", "feature"];
  return {
    deleteBranch: async (params: { branchName: string; expectedCommitHash: string }) => {
      calls.push({ method: "deleteBranch", params });
      if (["L-GO", "occupied"].includes(params.branchName)) return { ok: false, code: "in-use" };
      deleted.add(params.branchName);
      return { ok: true };
    },
    getLocalBranches: async (params: unknown) => {
      calls.push({ method: "branches", params });
      if (failBranches()) throw new Error("fixture-branches-failed");
      return {
        headRefType: "branch",
        currentBranchName: "L-GO",
        branches: branchNames
          .filter((name) => !deleted.has(name))
          .map((name) => ({
            name,
            isCurrent: name === "L-GO",
            checkedOutPath:
              name === managed?.().name
                ? managed!().checkoutPath
                : name === "occupied" || name === "external"
                  ? "/fixture/other-worktree"
                  : null,
            upstreamName: null,
            commitHash: "a".repeat(40),
            commitTimestampMs: null,
          })),
      };
    },
  };
}
