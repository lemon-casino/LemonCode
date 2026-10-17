import {
  replaceRemoteWorkspaceIdentityPath,
  resolveWorkspaceKey,
  type ExecutionSetSnapshot,
} from "@lcode/shared";
export function executionSetMemberScope(snapshot: ExecutionSetSnapshot, sourcePath: string) {
  const identity = snapshot.origin.workspaceIdentity
    ? replaceRemoteWorkspaceIdentityPath(snapshot.origin.workspaceIdentity, sourcePath)
    : undefined;
  if (snapshot.origin.workspaceIdentity && !identity)
    throw new Error("Invalid remote execution set source identity");
  return { workspacePath: sourcePath, ...(identity ? { workspaceIdentity: identity } : {}) };
}
export function assertExecutionSetScope(
  snapshot: ExecutionSetSnapshot,
  scope: { workspacePath: string; workspaceIdentity?: string },
) {
  if (resolveWorkspaceKey(snapshot.origin) !== resolveWorkspaceKey(scope))
    throw new Error("Execution set belongs to another project source");
}
export function executionSetOwner(executionSetId: string, repositoryId: string) {
  return { kind: "executionSet" as const, executionSetId, repositoryId };
}
