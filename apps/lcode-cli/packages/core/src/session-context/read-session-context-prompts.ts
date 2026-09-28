import type { ReadSessionContextInput } from "@lcode/contracts";

export function sessionContextExtractionInstructions(
  strategy: ReadSessionContextInput["strategy"],
): string {
  if (strategy === "handoff") {
    return [
      "Extract a handoff capsule from this material.",
      "Include current objective, decisions already made, files/commands/tests mentioned, blockers, and concrete next steps.",
      "Keep unrelated chat out.",
    ].join("\n");
  }

  return [
    "Extract only context relevant to the query.",
    "Prefer concrete facts: files, commands, decisions, errors, constraints, user preferences, and unresolved next steps.",
    "Mention message ids when helpful.",
  ].join("\n");
}

export function sessionContextSynthesisInstructions(
  strategy: ReadSessionContextInput["strategy"],
): string {
  if (strategy === "handoff") {
    return [
      "Synthesize these extracted notes into one bounded handoff capsule.",
      "Deduplicate repeated facts and keep the result directly actionable.",
    ].join("\n");
  }

  return [
    "Synthesize these extracted notes into one bounded context answer for the query.",
    "Deduplicate repeated facts and omit weakly related material.",
  ].join("\n");
}
