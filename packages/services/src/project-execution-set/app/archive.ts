import type { ExecutionSetSnapshot } from "@lcode/shared";
import type { ExecutionSetPorts } from "./ports.js";
import { executionSetOwner, executionSetMemberScope } from "../domain/identity.js";
export async function archiveExecutionSet(
  ports: ExecutionSetPorts,
  initial: ExecutionSetSnapshot,
  operationId: string,
  save: (snapshot: ExecutionSetSnapshot) => Promise<ExecutionSetSnapshot>,
  acknowledgeIgnoredFiles = false,
) {
  if (initial.status === "archived") return initial;
  if (initial.status === "restoring")
    throw new Error("Finish restoring the execution set before archiving");
  let snapshot = await save({
    ...initial,
    status: "archiving",
    archiveOperationId: initial.archiveOperationId ?? operationId,
    archiveIgnoredAcknowledged: initial.archiveIgnoredAcknowledged || acknowledgeIgnoredFiles,
  });
  const originalOperation = snapshot.archiveOperationId!;
  try {
    if (!snapshot.archiveSessionIds)
      snapshot = await save({
        ...snapshot,
        archiveSessionIds: (await ports.selectArchiveSessions?.(snapshot)) ?? [],
      });
    if (!snapshot.archiveStopReceipt) {
      const sessions = snapshot.sessions
        .filter((session) => session.status !== "released")
        .map((session) => session.sessionId);
      const receipt = sessions.length
        ? await ports.stopSessions(snapshot)
        : { stopped: true as const, sessionIds: [] };
      if (receipt.stopped !== true || sessions.some((id) => !receipt.sessionIds.includes(id)))
        throw new Error("Execution set sessions have not all stopped");
      snapshot = await save({
        ...snapshot,
        archiveStopReceipt: { operationId: originalOperation, sessionIds: receipt.sessionIds },
      });
    }
    if (snapshot.archiveStopReceipt?.operationId !== originalOperation)
      throw new Error("Execution set stop receipt differs from archive operation");
    for (const repository of snapshot.repositories) {
      if (repository.status === "archived") continue;
      if (!repository.bindingId) {
        // 中文依据：创建成功而 ACK 丢失时，消费者先于工作集收据落盘；按稳定 owner 对账，不能漏掉这棵树。
        const binding = await ports.worktrees.getOwnedBinding({
          ...executionSetMemberScope(snapshot, repository.repositoryRoot),
          ownerRef: executionSetOwner(snapshot.id, repository.id),
        });
        if (!binding) continue;
        repository.bindingId = binding.id;
        snapshot = await save(snapshot);
      }
      const owners = [
        executionSetOwner(snapshot.id, repository.id),
        ...snapshot.sessions.map((session) => ({
          kind: "session" as const,
          sessionId: session.sessionId,
        })),
      ];
      for (const owner of owners)
        await ports.worktrees.detachBindingConsumer({
          bindingId: repository.bindingId,
          owner,
          operationId: originalOperation,
          stopReceipt: { stopped: true, operationId: originalOperation },
        });
      await ports.worktrees.archive({
        bindingId: repository.bindingId,
        requestId: originalOperation,
        acknowledgeIgnoredFiles: snapshot.archiveIgnoredAcknowledged ?? false,
      });
      repository.status = "archived";
      snapshot = await save(snapshot);
    }
    await ports.setSessionsArchived?.(snapshot, true);
    return save({
      ...snapshot,
      status: "archived",
      error: undefined,
      sessions: snapshot.sessions.map((session) => ({ ...session, status: "released" })),
    });
  } catch (error) {
    return save({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
  }
}
