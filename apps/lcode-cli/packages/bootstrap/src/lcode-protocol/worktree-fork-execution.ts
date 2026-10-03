import {
  lcodeProtocolMethods,
  worktreeExecutionBindingSchema,
  worktreeGetBindingResultSchema,
} from "@lcode/shared";
import { createSessionId } from "@lcode/contracts";
import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";
import { buildWorkspaceRef } from "./workspace.js";
import { filesystemMcpRoots, remapFilesystemMcpServers } from "./worktree-mcp-scope.js";

export async function prepareForkWorktree(
  context: LCodeProtocolAgentServerContext,
  record: LCodeProtocolSessionRecord,
  commandId: string,
) {
  if (record.activeAbortController && !record.activeAbortController.signal.aborted)
    throw new Error("Fork source is busy; wait until file writers finish");
  const source = record.workspace;
  const origin = {
    workspacePath: source.originWorkspacePath ?? source.workspacePath,
    workspaceIdentity: source.originWorkspaceIdentity ?? source.workspaceIdentity,
  };
  const { binding: parentBinding } = await context.requestClient(
    lcodeProtocolMethods.worktreeGetBinding,
    { ...origin, taskId: source.bindingOwnerTaskId ?? record.app.sessionId },
    worktreeGetBindingResultSchema,
  );
  const originalServers = parentBinding
    ? remapFilesystemMcpServers(
        record.executionMcpServers,
        {
          repositoryRoot: parentBinding.checkoutPath,
          checkoutPath: parentBinding.repositoryRoot,
          workspacePath: origin.workspacePath,
        },
        source.workspacePath,
      )
    : record.executionMcpServers;
  const taskId = String(createSessionId(commandId));
  const parentSession = await context.deps.sessionStore?.getSession(record.app.sessionId);
  const binding = await context.requestClient(
    lcodeProtocolMethods.worktreePrepareExecution,
    {
      ...origin,
      requestId: commandId,
      taskId,
      taskName: parentSession?.title.slice(0, 256) || "分叉会话",
      forkSource: {
        workspacePath: source.workspacePath,
        workspaceIdentity: source.workspaceIdentity,
      },
      sourceFolderPaths: filesystemMcpRoots(originalServers, origin.workspacePath),
      ...(parentBinding
        ? {
            setupCommands:
              parentBinding.preparation?.environmentSource === "explicit" ||
              (!parentBinding.preparation && parentBinding.setup?.commands.length)
                ? parentBinding.setup?.commands
                : undefined,
            copyIgnoredPaths: parentBinding.setup?.copyIgnoredPaths,
            projectId: parentBinding.projectId,
          }
        : {}),
    },
    worktreeExecutionBindingSchema,
  );
  if (
    binding.status !== "ready" ||
    binding.taskId !== taskId ||
    binding.originalWorkspacePath !== origin.workspacePath ||
    binding.originalWorkspaceIdentity !== origin.workspaceIdentity
  )
    throw new Error("Fork worktree binding does not match its owner");
  const workspace = {
    ...buildWorkspaceRef(binding),
    executionBindingId: binding.id,
    originWorkspacePath: binding.originalWorkspacePath,
    originWorkspaceIdentity: binding.originalWorkspaceIdentity,
    ...(source.remoteSessionId ? { remoteSessionId: source.remoteSessionId } : {}),
  };
  return {
    taskId,
    workspace,
    mcpServers: remapFilesystemMcpServers(originalServers, binding, origin.workspacePath),
  };
}
