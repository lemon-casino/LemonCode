import type { ExecutionSetSnapshot } from "@lcode/shared";
import type { ExecutionSetPorts } from "./ports.js";
import { executionSetOwner } from "../domain/identity.js";
export async function restoreExecutionSet(
  ports: ExecutionSetPorts,
  initial: ExecutionSetSnapshot,
  operationId: string,
  save: (snapshot: ExecutionSetSnapshot) => Promise<ExecutionSetSnapshot>,
) {
  if (initial.status === "ready") return initial;
  if (!["archived", "restoring"].includes(initial.status))
    throw new Error("Finish the pending execution set operation before restoring");
  let snapshot = await save({
    ...initial,
    status: "restoring",
    restoreOperationId: initial.restoreOperationId ?? operationId,
    error: undefined,
  });
  try {
    for (const repository of snapshot.repositories) {
      if (!repository.bindingId)
        throw new Error(`${repository.repositoryRoot}: binding reference is missing`);
      const binding = await ports.worktrees.restore({
        bindingId: repository.bindingId,
        requestId: snapshot.restoreOperationId!,
      });
      if (binding.status !== "ready")
        throw new Error(binding.error ?? `${repository.repositoryRoot}: worktree is not ready`);
      await ports.worktrees.attachBindingConsumer({
        bindingId: binding.id,
        owner: executionSetOwner(snapshot.id, repository.id),
        operationId: snapshot.restoreOperationId!,
      });
      repository.status = "ready";
      repository.error = undefined;
      snapshot = await save(snapshot);
    }
    await ports.setSessionsArchived?.(snapshot, false);
    return save({
      ...snapshot,
      status: "ready",
      error: undefined,
      archiveOperationId: undefined,
      archiveSessionIds: undefined,
      archiveIgnoredAcknowledged: undefined,
      archiveStopReceipt: undefined,
      restoreOperationId: undefined,
    });
  } catch (error) {
    return save({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
  }
}
