import type { WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export async function preparationProgress(
  context: WorktreeContext,
  binding: WorktreeBinding,
  stage: NonNullable<WorktreeBinding["preparation"]>["stage"],
  output = "",
) {
  const previous = binding.preparation ?? {
    stage: "workspace" as const,
    log: "",
    logTruncated: false,
    cancelRequested: false,
    environmentSource: "none" as const,
  };
  const log = previous.log + output;
  const updated = {
    ...binding,
    updatedAt: new Date().toISOString(),
    preparation: {
      ...previous,
      stage,
      activeStep:
        stage === "workspace" || stage === "checkout" || stage === "environment"
          ? stage
          : previous.activeStep,
      log: log.slice(-65536),
      logTruncated: previous.logTruncated || log.length > 65536,
    },
  };
  await context.store.saveBinding(updated);
  return updated;
}

export async function assertPreparationActive(context: WorktreeContext, binding: WorktreeBinding) {
  if (!(await context.store.isPreparationCancelled(binding.id))) return;
  await preparationProgress(
    context,
    {
      ...binding,
      status: "cancelled",
      preparation: binding.preparation
        ? { ...binding.preparation, cancelRequested: true }
        : undefined,
    },
    "cancelled",
    "\nWorktree preparation cancelled.\n",
  );
  throw new Error("Worktree preparation cancelled");
}
