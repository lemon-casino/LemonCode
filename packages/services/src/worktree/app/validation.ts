import type { WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export async function validateIntegrationCandidate(
  context: WorktreeContext,
  operation: WorktreeIntegration,
  run: (checkout: string, command: string) => Promise<{ exitCode: number; output: string }>,
): Promise<WorktreeIntegration> {
  const save = async (value: WorktreeIntegration) => {
    const updated = { ...value, updatedAt: new Date().toISOString() };
    await context.store.saveOperation(updated);
    return updated;
  };
  let value = await save({
    ...operation,
    status: "validating",
    validationResults: [],
    error: undefined,
  });
  for (const command of value.validationCommands) {
    let result;
    try {
      result = await run(value.checkoutPath, command);
    } catch (error) {
      result = { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
    }
    value = await save({
      ...value,
      validationResults: [...value.validationResults, { command, ...result }],
    });
    if (result.exitCode !== 0)
      return save({
        ...value,
        status: "validation-failed",
        error: "Integration validation failed",
      });
  }
  const head = await context.git.command(value.checkoutPath, ["rev-parse", "HEAD"]);
  const dirty = await context.git.command(value.checkoutPath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (head !== value.candidateHead || dirty)
    return save({
      ...value,
      status: "awaiting-review",
      error: "Validation changed the reviewed candidate; commit and review it again",
    });
  return save({ ...value, status: "ready" });
}
