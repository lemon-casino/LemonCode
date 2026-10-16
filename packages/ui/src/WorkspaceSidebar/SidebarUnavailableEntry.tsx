import { Ellipsis, Folder, GitBranch, MessageCircle, Unplug } from "lucide-react";
import type { SidebarEntryRef } from "@lcode/shared";
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
import { SidebarPlacementItems } from "./SidebarPlacementItems.js";
import { SidebarEntryInteraction } from "./SidebarEntryInteraction.js";
import { useSidebarText } from "./sidebarText.js";

export function SidebarUnavailableEntry({
  entry,
  label,
}: {
  entry: SidebarEntryRef;
  label: string;
}) {
  const text = useSidebarText();
  const remote =
    entry.kind === "project"
      ? Boolean(entry.workspaceIdentity)
      : entry.kind === "worktree"
        ? Boolean(entry.origin.workspaceIdentity)
        : Boolean(entry.workspace.workspaceIdentity);
  const kind =
    entry.kind === "worktree"
      ? text(remote ? "remoteTree" : "localTree")
      : entry.kind === "project"
        ? text(remote ? "remoteProject" : "localProject")
        : text("chats");
  const Icon =
    entry.kind === "project" ? Folder : entry.kind === "worktree" ? GitBranch : MessageCircle;
  return (
    <SidebarEntryInteraction entry={entry}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onContextMenu={(event) => event.stopPropagation()}
            className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-foreground-subtle"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui-base">{label}</span>
              <span className="flex items-center gap-1 text-ui-xs text-foreground-subtlest">
                <Unplug className="size-3" />
                {kind} · {text("pendingSource")}
              </span>
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={text("more")}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <SidebarPlacementItems
                  entry={entry}
                  Item={DropdownMenuItem}
                  Separator={DropdownMenuSeparator}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled>{text("pendingSource")}</ContextMenuItem>
          <SidebarPlacementItems
            entry={entry}
            Item={ContextMenuItem}
            Separator={ContextMenuSeparator}
          />
        </ContextMenuContent>
      </ContextMenu>
    </SidebarEntryInteraction>
  );
}
