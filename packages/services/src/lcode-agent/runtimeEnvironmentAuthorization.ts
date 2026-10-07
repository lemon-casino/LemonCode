import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeEnvironmentReference, RuntimeEnvironmentScope } from "@lcode/shared";
import type { IWorktreeService, WorktreeBinding } from "../worktree/contract.js";

export interface RuntimeClientWorkspace extends RuntimeEnvironmentScope {
  remoteSessionId?: string;
}
export interface RuntimeRequestIdentity {
  sessionId: string;
  executionBindingId: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}
export function sameRuntimeWorkspacePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

/** 授权来自 attached workspace 内真实 task/alias，不从 cwd 或客户端自报 owner 推导。 */
export async function authorizeRuntimeBindingIdentity(
  worktrees: IWorktreeService,
  workspace: RuntimeClientWorkspace,
  request: RuntimeRequestIdentity,
): Promise<WorktreeBinding> {
  if ((workspace.remoteSessionId ?? "") !== (request.remoteSessionId ?? ""))
    throw new Error("scope-mismatch: runtime request attachment differs");
  const binding = await worktrees.getBinding({
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    taskId: request.sessionId,
  });
  if (
    !binding ||
    binding.id !== request.executionBindingId ||
    (binding.workspaceIdentity?.trim() ?? "") !== (request.workspaceIdentity?.trim() ?? "")
  )
    throw new Error("scope-mismatch: runtime request binding differs");
  const attached = (path: string, identity?: string) =>
    sameRuntimeWorkspacePath(workspace.workspacePath, path) &&
    (workspace.workspaceIdentity?.trim() || "") === (identity?.trim() || "");
  // 不能只信 getBinding 返回了同名记录：同路径不同远端 identity 仍是不同授权主体。
  if (
    !attached(binding.workspacePath, binding.workspaceIdentity) &&
    !attached(binding.originalWorkspacePath, binding.originalWorkspaceIdentity)
  )
    throw new Error("scope-mismatch: runtime binding is outside the attached workspace");
  return binding;
}

export async function authorizeRuntimeBinding(
  worktrees: IWorktreeService,
  workspace: RuntimeClientWorkspace,
  request: RuntimeRequestIdentity,
  environmentRef: RuntimeEnvironmentReference,
): Promise<WorktreeBinding> {
  const binding = await authorizeRuntimeBindingIdentity(worktrees, workspace, request);
  if (binding.status !== "ready") throw new Error("scope-mismatch: runtime binding is not ready");
  if (
    binding.environmentRef?.environmentId !== environmentRef.environmentId ||
    binding.environmentRef?.revision !== environmentRef.revision ||
    (environmentRef.manifestDigest !== undefined &&
      binding.environmentRef.manifestDigest !== environmentRef.manifestDigest)
  )
    throw new Error("stale-reference: runtime request environment differs");
  return binding;
}

export function assertRuntimeWorkspacePath(binding: WorktreeBinding, path: string): void {
  if (!sameRuntimeWorkspacePath(binding.workspacePath, path))
    throw new Error("scope-mismatch: runtime session workspace differs");
}

export async function assertRuntimeCwd(binding: WorktreeBinding, cwd: string): Promise<void> {
  if (!isAbsolute(cwd)) throw new Error("scope-mismatch: runtime cwd must be absolute");
  const [root, target] = await Promise.all([realpath(binding.checkoutPath), realpath(cwd)]);
  const child = relative(
    process.platform === "win32" ? root.toLowerCase() : root,
    process.platform === "win32" ? target.toLowerCase() : target,
  );
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("scope-mismatch: runtime cwd leaves the bound checkout");
}

/** 环境记录的 scope 是 Host 管理的 checkout 根；远程授权已在 binding 层验证。 */
export function runtimeStorageScope(binding: WorktreeBinding): RuntimeEnvironmentScope {
  return { workspacePath: binding.checkoutPath };
}
