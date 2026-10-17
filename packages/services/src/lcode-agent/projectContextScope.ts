import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  projectContextSnapshotSchema,
  replaceRemoteWorkspaceIdentityPath,
  resolveWorkspaceKey,
  type LCodeWorkspaceRef,
  type ProjectContextSnapshot,
} from "@lcode/shared";
import type { IWorktreeService } from "../worktree/contract.js";
import type { ProjectExecutionSetHostService } from "../project-execution-set/contract.js";
import {
  authorizeRuntimeBindingIdentity,
  sameRuntimeWorkspacePath,
} from "./runtimeEnvironmentAuthorization.js";

export async function authorizeProjectContextRequest(
  workspace: LCodeWorkspaceRef,
  sessionId: string,
  attached: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string },
  worktrees?: IWorktreeService,
  executionSets?: ProjectExecutionSetHostService,
): Promise<void> {
  if (workspace.executionSetRef) {
    if (
      !executionSets ||
      resolveWorkspaceKey(workspace.executionSetRef.origin) !== resolveWorkspaceKey(attached)
    )
      throw new Error("scope-mismatch: execution set belongs to another attached source");
    const current = await executionSets.resolveContext({
      ...workspace.executionSetRef.origin,
      executionSetId: workspace.executionSetRef.executionSetId,
      sessionId,
    });
    if (
      JSON.stringify(current.reference) !== JSON.stringify(workspace.executionSetRef) ||
      resolveWorkspaceKey(current.context.execution) !== resolveWorkspaceKey(workspace)
    )
      throw new Error("scope-mismatch: execution set reference changed");
    return;
  }
  if (!workspace.executionBindingId) {
    if (
      !sameRuntimeWorkspacePath(workspace.workspacePath, attached.workspacePath) ||
      resolveWorkspaceKey(workspace) !== resolveWorkspaceKey(attached)
    )
      throw new Error("scope-mismatch: project context differs from attached workspace");
    return;
  }
  if (!worktrees) throw new Error("Project context requires worktree capability");
  const binding = await authorizeRuntimeBindingIdentity(worktrees, attached, {
    sessionId,
    executionBindingId: workspace.executionBindingId,
    workspaceIdentity: workspace.workspaceIdentity,
    remoteSessionId: attached.remoteSessionId,
  });
  if (
    !sameRuntimeWorkspacePath(binding.workspacePath, workspace.workspacePath) ||
    binding.originalWorkspacePath !== workspace.originWorkspacePath ||
    (binding.originalWorkspaceIdentity ?? "") !== (workspace.originWorkspaceIdentity ?? "")
  )
    throw new Error("scope-mismatch: project context binding differs");
}

/** 设置 owner 提供逻辑成员；实际执行 Host 唯一负责映射和路径可用性。 */
export async function materializeProjectContext(
  snapshot: ProjectContextSnapshot | null,
  workspace: LCodeWorkspaceRef,
  sessionId: string,
  worktrees?: IWorktreeService,
  executionSets?: ProjectExecutionSetHostService,
): Promise<ProjectContextSnapshot | null> {
  if (workspace.executionSetRef) {
    if (!executionSets) throw new Error("Execution set context capability is unavailable");
    snapshot = (
      await executionSets.resolveContext({
        ...workspace.executionSetRef.origin,
        executionSetId: workspace.executionSetRef.executionSetId,
        sessionId,
      })
    ).context;
  }
  if (!snapshot) return null;
  const next = projectContextSnapshotSchema.parse(snapshot);
  const origin =
    workspace.executionSetRef?.origin ??
    (workspace.executionBindingId && workspace.originWorkspacePath
      ? {
          workspacePath: workspace.originWorkspacePath,
          workspaceIdentity: workspace.originWorkspaceIdentity,
        }
      : workspace);
  if (resolveWorkspaceKey(origin) !== resolveWorkspaceKey(next.origin))
    throw new Error("scope-mismatch: project definition belongs to another source");
  if (workspace.executionBindingId) {
    const binding = await worktrees?.getBinding({ ...origin, taskId: sessionId });
    if (
      !binding ||
      binding.id !== workspace.executionBindingId ||
      binding.status !== "ready" ||
      !sameRuntimeWorkspacePath(binding.workspacePath, workspace.workspacePath)
    )
      throw new Error("Project worktree binding is no longer ready");
    for (const member of next.members) {
      const child = relative(binding.repositoryRoot, resolve(member.sourcePath));
      if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
        throw new Error(
          `${member.sourcePath}: member is outside this worktree repository; create a collaboration execution set`,
        );
      member.workspacePath = resolve(binding.checkoutPath, child);
      member.workspaceIdentity = binding.workspaceIdentity
        ? (replaceRemoteWorkspaceIdentityPath(binding.workspaceIdentity, member.workspacePath) ??
          undefined)
        : undefined;
    }
    next.executionBindingId = binding.id;
  } else if (workspace.workspaceIdentity) {
    for (const member of next.members)
      member.workspaceIdentity =
        replaceRemoteWorkspaceIdentityPath(workspace.workspaceIdentity, member.workspacePath) ??
        workspace.workspaceIdentity;
  }
  next.execution = {
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
  };
  // 中文依据：新增/排队输入固定范围前检查目标 Host 的真实目录；缺失成员必须明确失败，不静默降成主目录。
  for (let offset = 0; offset < next.members.length; offset += 4)
    await Promise.all(
      next.members.slice(offset, offset + 4).map(async (member) => {
        if (!(await stat(member.workspacePath)).isDirectory())
          throw new Error(`${member.workspacePath}: Not a directory`);
      }),
    );
  return next;
}
