import { createHash } from "node:crypto";
import type { GoalAcceptance, GoalEvidence, GoalRequirement } from "@lcode/shared";
export { goalAcceptanceSchema, goalEvidenceSchema, goalEvidenceSummarySchema } from "@lcode/shared";
export type {
  GoalAcceptance,
  GoalEvidence,
  GoalEvidenceSummary,
  GoalRequirement,
} from "@lcode/shared";
export * from "./goal-evidence-head.js";

export const SESSION_ENTRY_GOAL_EVIDENCE = "goal/evidence/v1";
export function formatGoalAcceptanceForModel(acceptance: GoalAcceptance | undefined): string {
  return acceptance
    ? [
        "Explicit strict acceptance requirements (execute through ordinary permitted tools):",
        JSON.stringify(acceptance.requirements),
        "Run the exact declared checks after implementation and final integration. Missing, stale or unknown execution evidence stops goal completion.",
      ].join("\n")
    : "";
}
export function goalAcceptanceHash(acceptance: GoalAcceptance): string {
  return createHash("sha256").update(JSON.stringify(acceptance)).digest("hex");
}
export function goalRequirementMatches(
  requirement: GoalRequirement,
  execution: { source: "Bash" | "world.run"; command: string; args?: readonly string[] },
): boolean {
  return (
    requirement.source === execution.source &&
    requirement.command === execution.command.trim() &&
    (execution.source === "Bash" ||
      JSON.stringify(requirement.args ?? []) === JSON.stringify(execution.args ?? []))
  );
}
export function goalEvidenceEntryId(
  evidence: Pick<GoalEvidence, "goalId" | "executionId" | "requirementId" | "contractHash">,
): string {
  return `goal_evidence_${createHash("sha256")
    .update(
      JSON.stringify([
        evidence.goalId,
        evidence.executionId,
        evidence.requirementId,
        evidence.contractHash,
      ]),
    )
    .digest("hex")}`;
}
