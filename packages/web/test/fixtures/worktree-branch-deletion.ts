export function createWorktreeBranchFixture(
  calls: { method: string; params: unknown }[],
  failBranches: () => boolean,
) {
  const deleted = new Set<string>();
  return {
    deleteBranch: async (params: { branchName: string; expectedCommitHash: string }) => {
      calls.push({ method: "deleteBranch", params });
      if (params.branchName === "L-GO") return { ok: false, code: "in-use" };
      deleted.add(params.branchName);
      return { ok: true };
    },
    getLocalBranches: async (params: unknown) => {
      calls.push({ method: "branches", params });
      if (failBranches()) throw new Error("fixture-branches-failed");
      return {
        headRefType: "branch",
        currentBranchName: "L-GO",
        branches: ["L-GO", "feature"]
          .filter((name) => !deleted.has(name))
          .map((name) => ({
            name,
            isCurrent: name === "L-GO",
            upstreamName: null,
            commitHash: "a".repeat(40),
            commitTimestampMs: null,
          })),
      };
    },
  };
}
