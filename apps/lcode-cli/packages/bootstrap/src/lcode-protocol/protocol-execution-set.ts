import {
  executionSetExecutionResultSchema,
  type ExecutionIntent,
  type LCodeAgentMcpServer,
  type LCodeWorkspaceRef,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { buildWorkspaceRef } from "./workspace.js";
import { requestProjectContextForWorkspace } from "./admission-project-context.js";
import { scopeProjectFilesystemMcpServers } from "./worktree-mcp-scope.js";
type Context = Pick<LCodeProtocolAgentServerContext, "requestClient">;
export async function prepareProtocolExecutionSet(
  context: Context,
  input: {
    workspace: LCodeWorkspaceRef;
    taskId: string;
    requestId: string;
    execution: ExecutionIntent;
    mcpServers?: LCodeAgentMcpServer[];
    forkSource?: { executionSetId: string; sessionId: string };
  },
) {
  if (input.execution.environmentPolicy === "managed")
    throw new Error(
      "Collaboration execution sets currently require the target Host's local environment; managed environments must be prepared per repository before enabling this mode",
    );
  const projectContext =
    input.execution.executionSetId || input.forkSource
      ? undefined
      : await requestProjectContextForWorkspace(context, input.workspace, input.taskId);
  if (!projectContext && !input.execution.executionSetId && !input.forkSource)
    throw new Error("Save a project definition before creating a collaboration execution set");
  const resolved = await context.requestClient(
    "executionSet/prepareExecution",
    {
      workspacePath: input.workspace.workspacePath,
      workspaceIdentity: input.workspace.workspaceIdentity,
      sessionId: input.taskId,
      requestId: input.requestId,
      name: input.execution.taskName || projectContext?.name || "Collaboration",
      ...(projectContext ? { projectContext } : {}),
      ...(input.execution.executionSetId ? { executionSetId: input.execution.executionSetId } : {}),
      ...(input.forkSource ? { forkSource: input.forkSource } : {}),
      ...(input.execution.baseRefs
        ? { baseRefs: input.execution.baseRefs }
        : input.execution.baseRef && projectContext
          ? {
              baseRefs: Object.fromEntries(
                projectContext.members.map((member) => [member.memberId, input.execution.baseRef!]),
              ),
            }
          : {}),
    },
    executionSetExecutionResultSchema,
  );
  const workspace: LCodeWorkspaceRef = {
    ...buildWorkspaceRef(resolved.context.execution),
    executionSetRef: resolved.reference,
    originWorkspacePath: resolved.reference.origin.workspacePath,
    ...(resolved.reference.origin.workspaceIdentity
      ? { originWorkspaceIdentity: resolved.reference.origin.workspaceIdentity }
      : {}),
    ...(input.workspace.remoteSessionId
      ? { remoteSessionId: input.workspace.remoteSessionId }
      : {}),
  };
  return {
    workspace,
    mcpServers: scopeProjectFilesystemMcpServers(
      input.mcpServers,
      resolved.context.members.map((member) => member.workspacePath),
    ),
  };
}
export async function restoreProtocolExecutionSet(
  context: Context,
  reference: LCodeWorkspaceRef,
  taskId: string,
  persisted: LCodeWorkspaceRef,
  mcpServers?: LCodeAgentMcpServer[],
) {
  const ref = reference.executionSetRef!;
  const resolved = await prepareProtocolExecutionSet(context, {
    workspace: { ...buildWorkspaceRef(ref.origin), remoteSessionId: reference.remoteSessionId },
    taskId,
    requestId: `restore:${taskId}`,
    execution: { mode: "worktree", executionSetId: ref.executionSetId },
    mcpServers,
  });
  if (
    JSON.stringify(resolved.workspace.executionSetRef) !== JSON.stringify(ref) ||
    resolved.workspace.workspacePath !== persisted.workspacePath ||
    resolved.workspace.workspaceIdentity !== persisted.workspaceIdentity
  )
    throw new Error("Persisted collaboration execution paths or bindings differ from the owner");
  return resolved;
}
