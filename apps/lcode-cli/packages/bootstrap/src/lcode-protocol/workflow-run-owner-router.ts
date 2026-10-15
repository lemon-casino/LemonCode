import type { SessionId } from "@lcode/contracts";
import { WorkflowExecutionOwnerError } from "@lcode/adapters/storage";
import { lcodeProtocolErrorCodes, type LCodeWorkspaceRef } from "@lcode/shared";
import {
  WorkflowRunOwnerUnavailableError,
  type WithWorkflowRunOwner,
} from "../app/workflow-run-owner-router.js";
import {
  ConversationReadWorkspaceError,
  resolveConversationReadWorkspace,
} from "./conversation-read-workspace.js";
import {
  ProtocolRequestError,
  type LCodeProtocolAgentServerContext,
  type LCodeProtocolSessionRecord,
} from "./server-types.js";

const key = (workspace: LCodeWorkspaceRef) =>
  workspace.workspaceIdentity?.trim() || workspace.workspacePath;

/** 复用原 session registry/flight；路由本身不拥有 App，不另建运行表或恢复通道。 */
export function createProtocolWorkflowRunOwnerRouter(
  context: LCodeProtocolAgentServerContext,
  sourceSessionId: string,
  workspace: LCodeWorkspaceRef,
  activate: (
    sessionId: string,
    workspace: LCodeWorkspaceRef,
  ) => Promise<LCodeProtocolSessionRecord>,
): WithWorkflowRunOwner {
  return async (request, operation) => {
    context.assertServing?.();
    const source = context.sessions.get(sourceSessionId);
    if (
      !source ||
      key(source.workspace) !== key(workspace) ||
      source.workspace.remoteSessionId !== workspace.remoteSessionId
    )
      throw new WorkflowRunOwnerUnavailableError();
    const sourceApp = source.app;
    const assertSource = () => {
      context.assertServing?.();
      if (context.sessions.get(sourceSessionId) !== source || source.app !== sourceApp)
        throw new WorkflowRunOwnerUnavailableError();
    };
    let release = await context.sessionResidentPool?.acquireOperation([
      sourceSessionId,
      request.parentSessionId,
    ]);
    try {
      assertSource();
      const existing = context.sessions.get(request.parentSessionId);
      const stored = existing
        ? undefined
        : await context.deps.sessionStore?.getSession(request.parentSessionId as SessionId);
      const execution = await resolveConversationReadWorkspace(
        context,
        request.parentSessionId,
        stored,
        workspace,
      );
      assertSource();
      const target = existing ?? (await activate(request.parentSessionId, execution));
      assertSource();
      if (
        context.sessions.get(sourceSessionId) !== source ||
        context.sessions.get(request.parentSessionId) !== target ||
        target.workspace.remoteSessionId !== source.workspace.remoteSessionId
      )
        throw new WorkflowRunOwnerUnavailableError();
      const port = target.app.getDynamicWorkflowRunPort?.();
      if (!port || target.app.sessionId !== request.parentSessionId)
        throw new WorkflowRunOwnerUnavailableError();
      // 异步恢复后仍需核对原 parent，不能依靠调用方缓存来授权新代操作。
      const result = operation(port);
      // waitForTask 可能持续数小时；真正运行已由原 App pin，不能因此全局禁止 pool 回收。
      if (request.operation !== "resume") {
        release?.();
        release = undefined;
      }
      return await result;
    } catch (error) {
      if (
        error instanceof ConversationReadWorkspaceError ||
        error instanceof WorkflowExecutionOwnerError ||
        (error instanceof ProtocolRequestError &&
          error.code === lcodeProtocolErrorCodes.sessionUnavailable)
      )
        throw new WorkflowRunOwnerUnavailableError();
      throw error;
    } finally {
      release?.();
    }
  };
}
