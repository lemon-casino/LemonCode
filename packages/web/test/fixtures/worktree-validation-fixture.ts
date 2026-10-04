import type { WorktreeIntegration } from "@lcode/services";

export function validateFixtureCandidate(
  operation: WorktreeIntegration,
  candidate: string,
  failed: boolean,
): WorktreeIntegration {
  return {
    ...operation,
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
