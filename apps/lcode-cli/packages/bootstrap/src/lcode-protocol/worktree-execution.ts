import type { SessionId } from "@lcode/contracts";
import {
  lcodeProtocolMethods,
  lcodeWorkspaceRefSchema,
  worktreeExecutionBindingSchema,
  worktreeGetBindingResultSchema,
  runtimeEnvironmentCapabilitiesResultSchema,
  runtimeEnvironmentReferenceSchema,
  type RuntimeEnvironmentAction,
  type ExecutionIntent,
  type LCodeAgentMcpServer,
  type LCodeWorkspaceRef,
  type WorktreeExecutionBinding,
} from "@lcode/shared";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";
import { buildWorkspaceRef } from "./workspace.js";
import { filesystemMcpRoots, remapFilesystemMcpServers } from "./worktree-mcp-scope.js";
import { retainRuntimeEnvironmentSession } from "./runtime-environment-session.js";

export const WORKTREE_BINDING_ENTRY = "runtime/worktree_binding";
const MANAGED_ENVIRONMENT_PROTOCOL_VERSION = 1;
const MANAGED_EXECUTION_ACTIONS: readonly RuntimeEnvironmentAction[] = [
  "prepare",
  "resolveContext",
  "retainSession",
  "releaseConsumer",
];
export class WorktreePreparationError extends Error {
  readonly reasonCode = "fault.command.worktreePreparationFailed";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WorktreePreparationError";
  }
}

function bindingWorkspace(binding: WorktreeExecutionBinding): LCodeWorkspaceRef {
  return {
    ...buildWorkspaceRef(binding),
    executionBindingId: binding.id,
    originWorkspacePath: binding.originalWorkspacePath,
    ...(binding.originalWorkspaceIdentity
      ? { originWorkspaceIdentity: binding.originalWorkspaceIdentity }
      : {}),
    ...(binding.environmentRef ? { environmentRef: binding.environmentRef } : {}),
  };
}

function assertReadyBinding(
  binding: WorktreeExecutionBinding | null,
  taskId: string,
): asserts binding is WorktreeExecutionBinding {
  if (!binding || binding.taskId !== taskId || binding.status !== "ready") {
    throw new Error(
      `Worktree execution binding is unavailable: ${binding?.error ?? binding?.status ?? "missing"}`,
    );
  }
}

export async function prepareProtocolExecution(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient">,
  input: {
    workspace: LCodeWorkspaceRef;
    execution?: ExecutionIntent;
    taskId: string;
    requestId: string;
    mcpServers?: LCodeAgentMcpServer[];
  },
): Promise<{ workspace: LCodeWorkspaceRef; mcpServers?: LCodeAgentMcpServer[] }> {
  if (input.execution?.mode !== "worktree")
    return { workspace: input.workspace, mcpServers: input.mcpServers };
  const origin = input.workspace;
  if (
    (input.execution.originWorkspacePath &&
      input.execution.originWorkspacePath !== origin.workspacePath) ||
    (input.execution.originWorkspaceIdentity &&
      input.execution.originWorkspaceIdentity !== origin.workspaceIdentity)
  ) {
    throw new Error("Worktree execution origin does not match the requested workspace");
  }
  if (input.execution.environmentPolicy === "managed") {
    // 托管能力属于 Host，不是 CLI；先协商再产生 checkout 副作用，缺方法/动作不能降级。
    const { capabilities } = await context.requestClient(
      lcodeProtocolMethods.runtimeEnvironmentCapabilities,
      {
        workspacePath: origin.workspacePath,
        ...(origin.workspaceIdentity ? { workspaceIdentity: origin.workspaceIdentity } : {}),
      },
      runtimeEnvironmentCapabilitiesResultSchema,
    );
    if (
      !capabilities.managedEnvironments ||
      capabilities.protocolVersion !== MANAGED_ENVIRONMENT_PROTOCOL_VERSION ||
      MANAGED_EXECUTION_ACTIONS.some((action) => !capabilities.actions?.includes(action))
    )
      throw new Error(
        `Host managed runtime environment capability unavailable: ${capabilities.missingReason ?? "protocol or required actions missing"}`,
      );
  }
  const binding = await context.requestClient(
    lcodeProtocolMethods.worktreePrepareExecution,
    {
      taskId: input.taskId,
      taskName: input.execution.taskName,
      requestId: input.requestId,
      workspacePath: origin.workspacePath,
      workspaceIdentity: origin.workspaceIdentity,
      projectId: input.execution.projectId,
      environmentPolicy: input.execution.environmentPolicy,
      baseRef: input.execution.baseRef,
      setupCommands: input.execution.setupCommands,
      copyIgnoredPaths: input.execution.copyIgnoredPaths,
      retrySetup: input.execution.retrySetup,
      sourceFolderPaths: filesystemMcpRoots(input.mcpServers, origin.workspacePath),
    },
    worktreeExecutionBindingSchema,
  );
  assertReadyBinding(binding, input.taskId);
  if (
    input.execution.environmentPolicy === "managed" &&
    !runtimeEnvironmentReferenceSchema.safeParse(binding.environmentRef).success
  )
    throw new Error("Host returned a worktree without a ready managed environment reference");
  if (
    binding.originalWorkspacePath !== origin.workspacePath ||
    binding.originalWorkspaceIdentity !== origin.workspaceIdentity
  )
    throw new Error("Worktree binding origin mismatch");
  const workspace = {
    ...bindingWorkspace(binding),
    ...(origin.remoteSessionId ? { remoteSessionId: origin.remoteSessionId } : {}),
  };
  await retainRuntimeEnvironmentSession(context, workspace, input.taskId);
  return {
    workspace,
    mcpServers: remapFilesystemMcpServers(input.mcpServers, binding, origin.workspacePath),
  };
}

export async function restoreProtocolExecution(
  context: Pick<LCodeProtocolAgentServerContext, "requestClient" | "deps">,
  input: {
    taskId: string;
    workspace: LCodeWorkspaceRef;
    persistedWorkspace: LCodeWorkspaceRef;
    mcpServers?: LCodeAgentMcpServer[];
    ancestorTaskIds?: readonly string[];
  },
): Promise<{ workspace: LCodeWorkspaceRef; mcpServers?: LCodeAgentMcpServer[] }> {
  const entries = await context.deps.sessionStore?.sessionEntries?.({
    sessionID: input.taskId as SessionId,
    type: WORKTREE_BINDING_ENTRY,
  });
  const entry = entries?.at(-1);
  if (!entry) {
    if (input.workspace.executionBindingId)
      throw new Error("Worktree binding reference is missing from session storage");
    return { workspace: input.workspace, mcpServers: input.mcpServers };
  }
  const reference = lcodeWorkspaceRefSchema.parse(entry.data);
  if (!reference.executionBindingId || !reference.originWorkspacePath)
    throw new Error("Invalid persisted worktree binding reference");
  if (reference.bindingOwnerTaskId) {
    if (input.ancestorTaskIds?.includes(input.taskId))
      throw new Error("Inherited worktree binding parent cycle");
    const store = context.deps.sessionStore;
    if (!store) throw new Error("Inherited worktree binding requires session storage");
    const child = await store.getSession(input.taskId as SessionId);
    if (!child?.parentID)
      throw new Error("Inherited worktree binding has no persisted parent session");
    const parentEntries = await store.sessionEntries?.({
      sessionID: child.parentID,
      type: WORKTREE_BINDING_ENTRY,
    });
    const parentReference = lcodeWorkspaceRefSchema.safeParse(parentEntries?.at(-1)?.data);
    if (
      !parentReference.success ||
      parentReference.data.executionBindingId !== reference.executionBindingId ||
      (parentReference.data.bindingOwnerTaskId ?? child.parentID) !==
        reference.bindingOwnerTaskId ||
      parentReference.data.workspaceKey !== reference.workspaceKey
    )
      throw new Error("Inherited worktree binding does not match its persisted parent");
    // fork 的真实 parent/child 关系来自原子 SessionStore；UI 无法指定绑定 owner。
    // 先对账父引用，进程重启时可按真实祖先链幂等恢复 Host 的 child 引用登记。
    const parent = await store.getSession(child.parentID);
    if (!parent) throw new Error("Inherited worktree parent session is missing");
    if (parentReference.data.bindingOwnerTaskId)
      await restoreProtocolExecution(context, {
        taskId: child.parentID,
        workspace: parentReference.data,
        ancestorTaskIds: [...(input.ancestorTaskIds ?? []), input.taskId],
        persistedWorkspace: buildWorkspaceRef({
          workspacePath: parent.path ?? parent.directory,
          workspaceIdentity: parent.workspaceID,
        }),
      });
    await context.requestClient(
      lcodeProtocolMethods.worktreePrepareExecution,
      {
        taskId: input.taskId,
        requestId: `inherit:${input.taskId}`,
        workspacePath: reference.originWorkspacePath,
        workspaceIdentity: reference.originWorkspaceIdentity,
        parentBinding: {
          bindingId: reference.executionBindingId,
          bindingOwnerTaskId: reference.bindingOwnerTaskId,
          parentTaskId: child.parentID,
        },
      },
      worktreeExecutionBindingSchema,
    );
  }
  const { binding } = await context.requestClient(
    lcodeProtocolMethods.worktreeGetBinding,
    {
      taskId: reference.bindingOwnerTaskId ?? input.taskId,
      workspacePath: reference.originWorkspacePath,
      workspaceIdentity: reference.originWorkspaceIdentity,
    },
    worktreeGetBindingResultSchema,
  );
  assertReadyBinding(binding, reference.bindingOwnerTaskId ?? input.taskId);
  if (
    binding.id !== reference.executionBindingId ||
    binding.originalWorkspacePath !== reference.originWorkspacePath ||
    binding.originalWorkspaceIdentity !== reference.originWorkspaceIdentity ||
    binding.workspacePath !== reference.workspacePath ||
    binding.workspaceIdentity !== reference.workspaceIdentity ||
    input.persistedWorkspace.workspacePath !== reference.workspacePath ||
    input.persistedWorkspace.workspaceIdentity !== reference.workspaceIdentity
  ) {
    throw new Error(
      "Persisted worktree execution path or binding identity does not match its owner",
    );
  }
  // 环境引用对账（spec: specs/worktree-runtime-environments.md §8.1）：
  // 持久化引用带 environmentRef 而当前 binding 缺失或不一致 → 拒绝恢复，不回退原目录；
  // 旧会话（无环境引用）走原路径不报错。
  if (
    reference.environmentRef &&
    (binding.environmentRef?.environmentId !== reference.environmentRef.environmentId ||
      binding.environmentRef?.revision !== reference.environmentRef.revision ||
      (reference.environmentRef.manifestDigest !== undefined &&
        binding.environmentRef?.manifestDigest !== reference.environmentRef.manifestDigest))
  ) {
    throw new Error(
      `Persisted worktree environment reference does not match its owner binding: ` +
        `expected ${reference.environmentRef.environmentId}@${reference.environmentRef.revision}, ` +
        `got ${binding.environmentRef?.environmentId ?? "none"}@${binding.environmentRef?.revision ?? "none"}`,
    );
  }
  const workspace = {
    // 旧会话没有环境引用不能从 Host 当前 binding 偷渡升级；仅受信维护 CAS 能改持久引用。
    ...bindingWorkspace({ ...binding, environmentRef: reference.environmentRef }),
    ...(reference.bindingOwnerTaskId ? { bindingOwnerTaskId: reference.bindingOwnerTaskId } : {}),
    ...(reference.remoteSessionId ? { remoteSessionId: reference.remoteSessionId } : {}),
  };
  await retainRuntimeEnvironmentSession(context, workspace, input.taskId);
  return {
    workspace,
    mcpServers: remapFilesystemMcpServers(input.mcpServers, binding, reference.originWorkspacePath),
  };
}
