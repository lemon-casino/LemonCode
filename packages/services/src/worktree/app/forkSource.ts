import type { WorktreeBinding, WorktreeScope } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import type { CheckoutCoordinator } from "../nodeTypes.js";

export async function captureForkSource(
  context: WorktreeContext,
  coordinator: CheckoutCoordinator,
  binding: WorktreeBinding,
  source: WorktreeScope,
) {
  const info = await context.git.inspect(source.workspacePath);
  if (info.commonDirectory !== binding.commonDirectory)
    throw new Error("Fork source belongs to another repository");
  if (!(await context.git.registered(binding.repositoryRoot, info.root)))
    throw new Error("Fork source registration is missing");
  const lease = await coordinator.acquire({
    workspacePath: info.root,
    ownerId: `fork:${binding.id}`,
    waitMs: 1,
  });
  try {
    await context.git.assertIdle(info.root);
    const sourceBinding = { ...binding, checkoutPath: info.root };
    const snapshot = await context.git.snapshot(sourceBinding, true, false);
    if (!(await context.git.matchesSnapshot({ ...sourceBinding, snapshot })))
      throw new Error("Fork source changed while capturing files; retry when idle");
    return { ...binding, baseCommit: snapshot.head, forkSnapshot: snapshot };
  } finally {
    await coordinator.release(lease);
  }
}
