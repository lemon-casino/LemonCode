import { useState } from "react";
import { SidebarSourceReadError } from "./SidebarSourceReadError.js";
import { SidebarPlacementItems } from "./SidebarPlacementItems.js";
import { useSidebarText } from "./sidebarText.js";
import {
  Archive,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Copy,
  FolderOpen,
  GitBranch,
  GitFork,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Settings2,
} from "lucide-react";
import type { LCodeTaskMeta } from "@lcode/shared";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import type { SidebarWorktreeEntry } from "@/hooks/useSidebarWorktrees.js";
import { useTaskFork } from "@/hooks/useTaskFork.js";
import { useTaskForkAvailability } from "@/hooks/useTaskForkAvailability.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpenWorktreeSettings } from "@/hooks/useOpenWorktreeSettings.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";

export interface WorktreeFileTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}
export function WorktreeSidebarRow({
  entry,
  task,
  collapsed,
  onToggle,
  available,
  onCreateTask,
  onOpenFileTree,
  onSelectTask,
  sourceReadError,
  sourceRefreshing,
  onRefreshSource,
}: {
  entry: SidebarWorktreeEntry;
  task?: LCodeTaskMeta;
  collapsed: boolean;
  onToggle?: () => void;
  available: boolean;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenFileTree?: (target: WorktreeFileTarget) => void;
  onSelectTask: (path: string, taskId: string, identity?: string) => void;
  sourceReadError?: string;
  sourceRefreshing?: boolean;
  onRefreshSource?: () => void;
}) {
  const { intl } = useLCodeIntl();
  const { binding, origin } = entry;
  const sidebarText = useSidebarText();
  const remote = Boolean(origin.workspaceIdentity || origin.remoteSessionId || origin.remoteTarget);
  const entryRef = {
    kind: "worktree" as const,
    origin: {
      workspacePath: origin.workspacePath,
      ...(origin.workspaceIdentity ? { workspaceIdentity: origin.workspaceIdentity } : {}),
    },
    bindingId: binding.id,
  };
  const openSettings = useOpenWorktreeSettings();
  const { copyAbsolutePath } = useFileContextActions();
  const [contextOpen, setContextOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const text = (id: string) => intl.formatMessage({ id });
  const forkTask = task ?? {
    taskId: binding.taskId,
    workspacePath: origin.workspacePath,
    workspaceIdentity: origin.workspaceIdentity,
    executionBindingId: binding.id,
  };
  const { fork, pending, resolved } = useTaskFork(forkTask, origin.remoteSessionId, onSelectTask);
  const readOnly = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, origin.workspacePath, origin.workspaceIdentity),
  );
  const ready = available && !readOnly && resolved.rpcReady && binding.status === "ready";
  const availability = useTaskForkAvailability(
    forkTask,
    resolved,
    ready && Boolean(task) && (contextOpen || moreOpen),
  );
  const sourceHint = task
    ? intl.formatMessage(
        { id: "worktree.forkSource" },
        { title: task.title || text("taskList.untitled") },
      )
    : text("worktree.forkSourceUnavailable");
  const label = binding.displayName ?? binding.branch;
  const status = text(`worktree.binding.${binding.status}`);
  const Status =
    binding.status === "ready"
      ? CircleCheck
      : binding.status === "archived"
        ? Archive
        : ["preparing", "archiving", "restoring", "updating", "deleting"].includes(binding.status)
          ? LoaderCircle
          : CircleAlert;
  const target = {
    workspacePath: origin.workspacePath,
    workspaceIdentity: origin.workspaceIdentity,
    bindingId: binding.id,
  };
  const create = () => {
    if (!ready || !binding.taskId) return;
    onCreateTask?.({
      targetWorkspace: origin,
      createSource: "project",
      worktree: { bindingId: binding.id, bindingOwnerTaskId: binding.taskId, label },
    });
  };
  const openFolder = () =>
    onOpenFileTree?.({
      workspacePath: binding.checkoutPath,
      workspaceIdentity: binding.workspaceIdentity
        ? (replaceRemoteWorkspaceIdentityPath(binding.workspaceIdentity, binding.checkoutPath) ??
          binding.workspaceIdentity)
        : undefined,
      workspaceRemoteSessionId: origin.remoteSessionId,
      workspaceName: label,
    });
  const items = [
    {
      id: "worktree.newTask",
      icon: Plus,
      disabled: !ready || !onCreateTask,
      title: ready ? undefined : available ? status : sidebarText("offline"),
      action: create,
    },
    {
      id: "taskList.fork.sameWorktree",
      icon: GitFork,
      disabled: !ready || !task || pending || !availability.same,
      title: sourceHint,
      action: () => void fork("same"),
    },
    {
      id: "taskList.fork.newWorktree",
      icon: GitBranch,
      disabled: !ready || !task || pending || !availability.worktree,
      title: availability.reason ?? sourceHint,
      action: () => void fork("worktree"),
    },
    {
      id: "worktree.openFolder",
      icon: FolderOpen,
      disabled: !ready || !onOpenFileTree,
      action: openFolder,
    },
    {
      id: "worktree.copyPath",
      icon: Copy,
      disabled: !binding.checkoutPath,
      action: () => void copyAbsolutePath({ path: binding.checkoutPath, kind: "directory" }),
    },
    { id: "worktree.manage", icon: Settings2, disabled: false, action: () => openSettings(target) },
  ];
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger asChild>
        <div
          className="group flex h-8 min-w-0 items-center gap-0.5 rounded-md px-1 hover:bg-surface-hover"
          data-testid="sidebar-worktree"
          data-binding-id={binding.id}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left text-ui-base hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
            aria-expanded={onToggle ? !collapsed : undefined}
            aria-label={label}
            onClick={onToggle}
          >
            {onToggle ? (
              <ChevronRight
                className={`size-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
              />
            ) : null}
            <GitBranch className="size-3.5 shrink-0 text-foreground-subtle" />
            <span className="min-w-0 truncate" title={`${origin.label} · ${binding.branch}`}>
              {label}
            </span>
          </button>
          {sourceReadError ? (
            <SidebarSourceReadError
              label={label}
              workspacePath={origin.workspacePath}
              error={sourceReadError}
              refreshing={sourceRefreshing}
              onRefresh={onRefreshSource}
            />
          ) : null}
          <span
            className="max-w-20 truncate text-ui-xs text-foreground-subtlest"
            title={`${sidebarText(remote ? "remoteTree" : "localTree")} · ${origin.label}`}
          >
            {sidebarText(remote ? "remoteTree" : "localTree")} · {origin.label}
          </span>
          <span
            role="img"
            aria-label={status}
            title={status}
            className="flex shrink-0 px-1 text-foreground-subtle"
          >
            <Status
              className={`size-3 ${Status === LoaderCircle ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
          </span>
          <span
            className={`flex shrink-0 items-center ${contextOpen || moreOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"}`}
          >
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0"
              aria-label={text("worktree.openFolder")}
              title={binding.checkoutPath}
              disabled={!ready || !onOpenFileTree}
              onClick={openFolder}
            >
              <FolderOpen className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0"
              aria-label={text("worktree.newTask")}
              title={text("worktree.newTask")}
              disabled={!ready || !onCreateTask}
              onClick={create}
            >
              <Plus className="size-3.5" />
            </Button>
            <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 shrink-0"
                  aria-label={text("worktree.moreActions")}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {remote ? (
                  <DropdownMenuItem disabled>
                    {sidebarText("remoteTree")} · {origin.label}
                  </DropdownMenuItem>
                ) : null}
                {items.slice(0, -1).map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    disabled={item.disabled}
                    title={item.title}
                    onSelect={item.action}
                  >
                    <item.icon className="size-3.5" />
                    <span className="min-w-0 whitespace-normal">{text(item.id)}</span>
                  </DropdownMenuItem>
                ))}
                <SidebarPlacementItems
                  entry={entryRef}
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openSettings(target)}>
                  <Settings2 className="size-3.5" />
                  {text("worktree.manage")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </ContextMenuTrigger>
      {/* 右键点击点两侧的可用空间小于视口；复用共享菜单的宽度约束，避免窄屏长文案被裁掉。 */}
      <ContextMenuContent>
        {remote ? (
          <ContextMenuItem disabled>
            {sidebarText("remoteTree")} · {origin.label}
          </ContextMenuItem>
        ) : null}
        {items.slice(0, -1).map((item) => (
          <ContextMenuItem
            key={item.id}
            disabled={item.disabled}
            title={item.title}
            onSelect={item.action}
          >
            <item.icon className="size-3.5" />
            <span className="min-w-0 whitespace-normal">{text(item.id)}</span>
          </ContextMenuItem>
        ))}
        <SidebarPlacementItems
          entry={entryRef}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
        />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openSettings(target)}>
          <Settings2 className="size-3.5" />
          {text("worktree.manage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
