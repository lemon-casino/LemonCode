import { createHash } from "node:crypto";
import type { GoalEvidence } from "@lcode/contracts";

const executionFacts = Symbol("live-world-run-execution-facts");
export function attachWorldExecutionFacts<T extends object>(
  result: T,
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
): T {
  Object.defineProperty(result, executionFacts, {
    value: {
      exitCode: exitCode ?? null,
      output: {
        sha256: createHash("sha256").update(stdout).update("\0").update(stderr).digest("hex"),
        bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
        truncated: false,
        artifactRefs: [],
      },
    },
    enumerable: false,
  });
  return result;
}
export function readWorldExecutionFacts(
  result: unknown,
): { exitCode: number | null; output: GoalEvidence["output"] } | undefined {
  return typeof result === "object" && result !== null
    ? (
        result as { [executionFacts]?: { exitCode: number | null; output: GoalEvidence["output"] } }
      )[executionFacts]
    : undefined;
}
