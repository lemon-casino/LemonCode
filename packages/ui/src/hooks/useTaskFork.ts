import { useCallback, useRef, useState } from "react";
import type { LCodeTaskMeta } from "@lcode/shared";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import { usePlatform } from "./usePlatform.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { isPendingCommandForWorkspace } from "@/v4/pendingCommandWorkspace.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";

export type TaskForkNavigation = (
  workspacePath: string,
  sessionId: string,
  workspaceIdentity?: string,
) => void;

export function useTaskFork(
  task: LCodeTaskMeta,
  remoteSessionId: string | undefined,
  onCreated: TaskForkNavigation,
): {
  fork: (workspaceMode: "same" | "worktree") => Promise<void>;
  pending: boolean;
  resolved: ReturnType<typeof useWorkspaceServicesResolution>;
} {
  const resolved = useWorkspaceServicesResolution(
    task.workspacePath,
    remoteSessionId,
    task.workspaceIdentity,
  );
  const platform = usePlatform();
  const tabStore = useTabStoreApi();
  const { intl } = useLCodeIntl();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const fork = useCallback(
    async (workspaceMode: "same" | "worktree") => {
      if (pendingRef.current || !resolved.rpcReady) return;
      pendingRef.current = true;
      setPending(true);
      const activeTabId = tabStore.getState().activeTabId;
      // 新工作树分叉同样没有管理动作可挂失效通知：确认成功后广播一次，
      // 侧栏工作树列表才会自己出现这条树，而不是等用户点刷新。
      const announceForkWorktree = () => {
        if (workspaceMode !== "worktree") return;
        useWorktreeLifecycleStore
          .getState()
          .invalidate(task.workspacePath, task.workspaceIdentity);
      };
      // 子会话属于原项目；actual checkout 只供执行。远程树不能被当成未连接的新项目导航。
      const selectChild = (sessionId: string) => {
        if (tabStore.getState().activeTabId === activeTabId)
          onCreated(task.workspacePath, sessionId, task.workspaceIdentity);
      };
      let lease: ReturnType<typeof acquireWorkspaceConnection> | undefined;
      try {
        lease = acquireWorkspaceConnection(
          {
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            ...(resolved.remoteSessionId ? { remoteSessionId: resolved.remoteSessionId } : {}),
          },
          resolved.services.lcodeAgentService,
          resolved.isRemoteTarget ? undefined : platform.createLocalMediaPreviewUrl,
        );
        lease.activateRemoteService();
        // ACK 丢失时先查询同一 Host 的原命令；未确认结果前不换 commandId 创建第二个 child。
        const previous = pendingCommandRegistry
          .list(task.taskId)
          .find(
            (entry) =>
              entry.replay.type === "forkSession" &&
              isPendingCommandForWorkspace(entry, task.workspacePath, task.workspaceIdentity),
          );
        if (previous) {
          const queried = await lease.transport.queryCommands({
            commands: [{ sessionId: task.taskId, commandId: previous.commandId }],
          });
          const result = queried.results[0]?.result;
          if (!result || result === "unknown") {
            if (result === "unknown")
              pendingCommandRegistry.settle(task.taskId, previous.commandId);
            throw new Error(intl.formatMessage({ id: "taskList.fork.unknown" }));
          }
          if (result.reasonCode === "fault.command.queryUnavailable")
            throw new Error(result.reasonCode);
          pendingCommandRegistry.applyQuery(queried);
          if (
            (result.status === "accepted" || result.status === "duplicate") &&
            result.result?.type === "forkSession"
          ) {
            selectChild(result.result.sessionId);
            announceForkWorktree();
            return;
          }
          throw new Error(result.message ?? result.reasonCode ?? result.status);
        }
        // rowsRange 复用原冷恢复管线，并读取 CLI revision；不能用任务列表 updatedAt 冒充 CAS。
        const page = await lease.transport.rowsRange({ sessionId: task.taskId, limit: 1 });
        const envelope = createCommandEnvelope({
          type: "forkSession",
          payload: { workspaceMode },
          sessionId: task.taskId,
          baseRevision: page.atRevision,
        });
        pendingCommandRegistry.record(envelope, {
          workspace: {
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
          },
        });
        const ack = await lease.transport.sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        if (
          (ack.status !== "accepted" && ack.status !== "duplicate") ||
          ack.result?.type !== "forkSession"
        )
          throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
        selectChild(ack.result.sessionId);
        announceForkWorktree();
      } catch (reason) {
        toast(`${intl.formatMessage({ id: "taskList.fork.failed" })}: ${getErrorMessage(reason)}`, {
          variant: "warning",
        });
      } finally {
        lease?.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [resolved, task, platform.createLocalMediaPreviewUrl, intl, onCreated, tabStore],
  );
  return { fork, pending, resolved };
}
