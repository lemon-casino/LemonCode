import type { LCodeProvider } from "@lcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useActiveExecutionWorkspace } from "@/hooks/useActiveExecutionWorkspace.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

export interface TaskDirectoryActions {
  path: string | null;
  copyLabel: string;
  canOpen: boolean;
  disabledReason?: string;
  openDisabledReason?: string;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  fileManagerLabel: string;
  directory: TaskDirectoryActions;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  executionBindingId,
  intl,
  loadTaskPaths = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: LCodeProvider;
  executionBindingId?: string;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  // 会话身份仍属于原项目；文件操作必须用 owner 的执行目录，不能复用查询/管理的 workspacePath。
  const execution = useActiveExecutionWorkspace(
    workspacePath,
    workspaceIdentity,
    loadTaskPaths && executionBindingId ? taskId : null,
    remoteSessionId,
  );
  const directoryPath = executionBindingId
    ? execution.workspace?.executionBindingId === executionBindingId &&
      execution.binding?.id === executionBindingId
      ? execution.workspace.workspacePath
      : null
    : workspacePath;
  const directoryIdentity = executionBindingId
    ? execution.workspace?.workspaceIdentity
    : workspaceIdentity;
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // task session/log 路径只用于右键菜单项；菜单未打开时不要在列表重排中批量触发 RPC。
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const isRemote = Boolean(
    remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
  );
  const canOpen =
    Boolean(directoryPath) && (!isRemote || workspaceOpenTarget.remoteTarget?.kind === "wsl");
  const directory = {
    path: directoryPath,
    copyLabel: intl.formatMessage({
      id: executionBindingId ? "worktree.copyPath" : "appHeader.copyPath",
    }),
    canOpen,
    disabledReason: !directoryPath
      ? intl.formatMessage({
          id: execution.pending ? "worktree.pathLoading" : "worktree.pathUnavailable",
        })
      : undefined,
    openDisabledReason:
      isRemote && workspaceOpenTarget.remoteTarget?.kind !== "wsl"
        ? intl.formatMessage({ id: "worktree.remoteFileManagerUnavailable" })
        : undefined,
  };
  const handleCopyText = useCallback(async (label: string, value: string | null) => {
    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
    } catch (error) {
      logger.warn("[TaskListItem] 复制文本失败", {
        label,
        value,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    if (!canOpen || !directoryPath) return;
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // 远程项目路径不是宿主机路径。无法精确解析为 WSL 时必须失败关闭，
        // 避免 SSH/Docker 的 Linux 路径误落到原生 Windows、macOS 或 Linux 文件管理器。
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: directoryPath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", directoryPath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity: directoryIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: directoryPath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, directoryPath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(directoryPath);
    if (!result.success) {
      // 文件管理器与复制路径使用同一个已确认执行目录，既不打开会话记录，也不回退原项目。
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: directoryPath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
    canOpen,
    directoryPath,
    directoryIdentity,
  ]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel: executionBindingId
      ? intl.formatMessage({ id: "worktree.openInFileManager" })
      : getFileManagerLabel(intl),
    directory,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
