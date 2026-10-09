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
import { retainRuntimeEnvironmentSession } from "./runtime-environment-session.js";
import { summarizeWorktreeTaskName } from "./worktree-task-name.js";

function assertForkSourceIdle(record: LCodeProtocolSessionRecord) {
  if (record.activeAbortController && !record.activeAbortController.signal.aborted)
    throw new Error("Fork source is busy; wait until file writers finish");
}

export async function prepareForkWorktree(
  context: LCodeProtocolAgentServerContext,
  record: LCodeProtocolSessionRecord,
  commandId: string,
) {
  assertForkSourceIdle(record);
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
  const taskId = createSessionId(commandId);
  const parentSession = await context.deps.sessionStore?.getSession(record.app.sessionId);
  const taskName = await summarizeWorktreeTaskName(context, {
    workspace: {
      ...origin,
      workspaceKey: origin.workspaceIdentity?.trim() || origin.workspacePath,
      remoteSessionId: source.remoteSessionId,
    },
    taskId,
    text: parentSession?.title ?? "",
    modelSelection: record.app.runtime?.getSessionModelSelection(),
    fallbackName: "分叉会话",
  });
  // 命名会等待模型，来源可能已开始新一轮；快照前必须重新检查运行事实。
  assertForkSourceIdle(record);
  const binding = await context.requestClient(
    lcodeProtocolMethods.worktreePrepareExecution,
    {
      ...origin,
      requestId: commandId,
      taskId,
      taskName,
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
  await retainRuntimeEnvironmentSession(context, workspace, taskId);
  return {
    taskId,
    workspace,
    mcpServers: remapFilesystemMcpServers(originalServers, binding, origin.workspacePath),
  };
}
