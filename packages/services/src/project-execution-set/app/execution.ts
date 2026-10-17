import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  replaceRemoteWorkspaceIdentityPath,
  type ExecutionSetSnapshot,
  type ExecutionSetRef,
} from "@lcode/shared";
import type { CheckoutLease, IWorktreeHostService } from "../../worktree/contract.js";
import type { ExecutionSetPorts } from "./ports.js";
import { executionSetMemberScope, executionSetOwner } from "../domain/identity.js";

export async function resolveExecutionSetContext(
  ports: ExecutionSetPorts,
  snapshot: ExecutionSetSnapshot,
) {
  if (snapshot.status !== "ready" || !snapshot.repositories.length)
    throw new Error(snapshot.error ?? "All execution set repositories must be ready");
  const context = structuredClone(snapshot.projectContext);
  const reference: ExecutionSetRef = {
    executionSetId: snapshot.id,
    projectId: context.projectId,
    origin: snapshot.origin,
    bindings: [],
  };
  for (const repository of snapshot.repositories) {
    if (repository.status !== "ready" || !repository.bindingId)
      throw new Error(`${repository.repositoryRoot}: repository is not ready`);
    const binding = await ports.worktrees.getOwnedBinding({
      ...executionSetMemberScope(snapshot, repository.repositoryRoot),
      ownerRef: executionSetOwner(snapshot.id, repository.id),
    });
    if (!binding || binding.id !== repository.bindingId || binding.status !== "ready")
      throw new Error(`${repository.repositoryRoot}: worktree is no longer ready`);
    reference.bindings.push({
      repositoryId: repository.id,
      bindingId: binding.id,
      workspacePath: binding.workspacePath,
      ...(binding.workspaceIdentity ? { workspaceIdentity: binding.workspaceIdentity } : {}),
    });
    for (const member of context.members.filter((member) =>
      repository.memberIds.includes(member.memberId),
    )) {
      const child = relative(repository.repositoryRoot, resolve(member.sourcePath));
      if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
        throw new Error(`${member.sourcePath}: member moved outside its repository`);
      member.workspacePath = resolve(binding.checkoutPath, child);
      member.workspaceIdentity = snapshot.origin.workspaceIdentity
        ? (replaceRemoteWorkspaceIdentityPath(
            snapshot.origin.workspaceIdentity,
            member.workspacePath,
          ) ?? undefined)
        : undefined;
      member.bindingId = binding.id;
      member.repositoryId = repository.id;
    }
  }
  if (context.members.some((member) => !member.bindingId))
    throw new Error("An execution set member has no repository binding");
  const primary =
    context.members.find((member) => member.sourcePath === context.origin.workspacePath) ??
    context.members[0]!;
  context.execution = {
    workspacePath: primary.workspacePath,
    ...(primary.workspaceIdentity ? { workspaceIdentity: primary.workspaceIdentity } : {}),
  };
  context.executionSetId = snapshot.id;
  return { reference, context };
}

export async function acquireExecutionSetPermits(
  ports: ExecutionSetPorts,
  snapshot: ExecutionSetSnapshot,
  ownerId: string,
  permits: Pick<IWorktreeHostService, "acquireCheckout" | "releaseCheckout">,
) {
  const { reference } = await resolveExecutionSetContext(ports, snapshot);
  const leases: CheckoutLease[] = [];
  try {
    for (const binding of [...reference.bindings].sort((a, b) =>
      a.workspacePath.localeCompare(b.workspacePath),
    ))
      leases.push(
        await permits.acquireCheckout({
          workspacePath: binding.workspacePath,
          workspaceIdentity: binding.workspaceIdentity,
          ownerId,
          mode: "shared",
        }),
      );
    return leases;
  } catch (error) {
    for (const lease of leases.reverse())
      await permits.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
    throw error;
  }
}
