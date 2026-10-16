import { useState } from "react";
import { ArchiveRestore, Cloud, Ellipsis, Folder, Trash2 } from "lucide-react";
import type { LCodeTaskMeta } from "@lcode/shared";
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
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { cn } from "@/components/lib/utils.js";
import { useSidebarText } from "./sidebarText.js";

export function ArchivedSidebarRow({
  task,
  label,
  active,
  deleting,
  available,
  sortBy,
  open,
  restore,
  remove,
}: {
  task: LCodeTaskMeta;
  label: string;
  active: boolean;
  deleting: boolean;
  available: boolean;
  sortBy: "created" | "updated";
  open(): void;
  restore(): void;
  remove(): void;
}) {
  const { intl } = useLCodeIntl();
  const text = useSidebarText();
  const [menuOpen, setMenuOpen] = useState(false);
  const { copyAbsolutePath } = useFileContextActions();
  const title = task.title || intl.formatMessage({ id: "taskList.untitled" });
  const restoreLabel = intl.formatMessage({ id: "taskList.unarchive" });
  const deleteLabel = intl.formatMessage({ id: "taskList.delete" });
  const items = (
    Item: typeof ContextMenuItem | typeof DropdownMenuItem,
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <Item disabled>
        {task.workspaceIdentity ? text("remoteProject") : text("localProject")} · {label}
      </Item>
      <Item disabled={!available} onSelect={open}>
        {intl.formatMessage({ id: "common.open" })}
      </Item>
      <Item disabled={!available || deleting} onSelect={restore}>
        {restoreLabel}
      </Item>
      <Separator />
      <Item onSelect={() => void copyAbsolutePath({ path: task.workspacePath, kind: "directory" })}>
        {text(task.workspaceIdentity ? "remotePath" : "copyPath")}
      </Item>
      <Item onSelect={() => void copyAbsolutePath({ path: task.taskId, kind: "file" })}>
        {intl.formatMessage({ id: "appHeader.copySessionId" })}
      </Item>
      <Separator />
      <Item disabled={!available || deleting} variant="destructive" onSelect={remove}>
        {deleteLabel}
      </Item>
    </>
  );
  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <li
          data-testid={`archived-sidebar-task-${task.taskId}`}
          onContextMenu={(event) => event.stopPropagation()}
          className={cn(
            "group flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5",
            active ? "bg-selected" : "hover:bg-surface-hover",
            menuOpen && "bg-surface-hover",
          )}
        >
          <button
            type="button"
            disabled={!available}
            onClick={open}
            className="min-w-0 flex-1 text-left focus-visible:ring-2 focus-visible:ring-input-border-focused"
          >
            <span className="block truncate text-ui-base">{title}</span>
            <span className="flex items-center gap-1 text-ui-xs text-foreground-subtlest">
              {task.workspaceIdentity ? (
                <Cloud className="size-3" />
              ) : (
                <Folder className="size-3" />
              )}
              <span className="min-w-0 truncate">{label}</span>
              <span className="ml-auto shrink-0">
                {formatTaskRelativeTime(
                  sortBy === "created" ? task.createdAt : task.updatedAt,
                  intl,
                )}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!available || deleting}
              aria-label={restoreLabel}
              onClick={restore}
            >
              <ArchiveRestore className="size-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`${title} · ${text("more")}`}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {items(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!available || deleting}
              className="text-destructive"
              aria-label={deleteLabel}
              onClick={remove}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>{items(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
  );
}
