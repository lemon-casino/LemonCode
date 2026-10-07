import type { WorktreeIntegration } from "@lcode/services";

export function validateFixtureCandidate(
  operation: WorktreeIntegration,
  candidate: string,
  failed: boolean,
): WorktreeIntegration {
  const environmentPolicy = operation.environmentPolicy ?? "local";
  const validationReceipts = operation.validationCommands.map((command) => ({
    candidateHead: candidate,
    candidateTree: "fixture-tree",
    sourceHead: operation.sourceHead,
    targetHead: operation.targetHead,
    targetBranch: operation.targetBranch,
    environmentPolicy,
    environmentRef: operation.environmentRef,
    revision: operation.environmentRef?.revision,
    manifestDigest: operation.environmentRef?.manifestDigest,
    command,
    outcome: failed ? ("failed" as const) : ("passed" as const),
    exitCode: failed ? 1 : 0,
    output: failed ? "src/button.ts:12 validation failed" : "checked",
    verifiedAt: "now",
  }));
  return {
    ...operation,
    environmentPolicy,
    validationReceipts,
    candidateEvidence:
      failed || operation.status === "conflicted"
        ? undefined
        : {
            candidateHead: candidate,
            candidateTree: "fixture-tree",
            sourceHead: operation.sourceHead,
            targetHead: operation.targetHead,
            targetBranch: operation.targetBranch,
            environmentPolicy,
            environmentRef: operation.environmentRef,
            manifestDigest: operation.environmentRef?.manifestDigest,
            validationCommands: operation.validationCommands,
            validationReceipts,
            validatedAt: "now",
          },
    status: failed
      ? "validation-failed"
      : operation.status === "conflicted"
        ? "awaiting-review"
        : "ready",
    candidateHead: candidate,
    conflictPaths: [],
    validationResults: [
      {
        command: "fixture-check",
        exitCode: failed ? 1 : 0,
        output: failed ? "src/button.ts:12 validation failed" : "checked",
      },
    ],
  };
}
