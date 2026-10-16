import { useSidebarText } from "@/WorkspaceSidebar/sidebarText.js";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import type { TaskDirectoryActions } from "@/useTaskListItemContextActions.js";

function AuxiliaryGroup({ children }: { children: React.ReactNode }) {
  const text = useSidebarText();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>{text("more")}</ContextMenuSubTrigger>
      <ContextMenuSubContent>{children}</ContextMenuSubContent>
    </ContextMenuSub>
  );
}
function CopyGroup({ children }: { children: React.ReactNode }) {
  const text = useSidebarText();
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>{text("copyInfo")}</ContextMenuSubTrigger>
      <ContextMenuSubContent>{children}</ContextMenuSubContent>
    </ContextMenuSub>
  );
}
export function TaskListItemContextMenu({
  intl,
  isPinned,
  fileManagerLabel,
  directory,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  disableTaskActions = false,
  disabledReason,
  forkMenu,
  organizationMenu,
  hideMobileUnsupportedActions,
  openMenu,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  fileManagerLabel: string;
  directory?: TaskDirectoryActions;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  /** 「在分屏打开」（仅桌面 shell 传入）。 */
  onOpenInSplitPane?: () => void;
  /** 叶子数达上限且该 session 未在任何 pane 时禁用。 */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
  forkMenu?: React.ReactNode;
  organizationMenu?: React.ReactNode;
  hideMobileUnsupportedActions?: boolean;
  openMenu?: React.ReactNode;
}) {
  return (
    <ContextMenuContent className="w-52">
      {openMenu}
      {forkMenu}
      <TaskActionMenuContent
        organizationMenu={organizationMenu}
        AuxiliaryGroup={AuxiliaryGroup}
        CopyGroup={CopyGroup}
        hideMobileUnsupportedActions={hideMobileUnsupportedActions}
        intl={intl}
        isPinned={isPinned}
        fileManagerLabel={fileManagerLabel}
        directory={directory}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenInSplitPane={onOpenInSplitPane}
        openInSplitPaneDisabled={openInSplitPaneDisabled}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        onCopySessionId={onCopySessionId}
        onViewModelTrajectory={onViewModelTrajectory}
        disableTaskActions={disableTaskActions}
        disabledReason={disabledReason}
      />
    </ContextMenuContent>
  );
}
