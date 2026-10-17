import { useCallback, useState } from "react";
import { ChevronDown, Ellipsis, RefreshCw, Trash2 } from "lucide-react";
import type { WorktreeBinding } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { WorkspaceArchivedTasksFlatSection } from "@/WorkspaceArchivedTasksFlatSection.js";
import { isWorktreeSidebarTask } from "@/lib/worktreeSidebar.js";
import type { LCodeTaskMeta } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";
import { useSidebarText } from "./sidebarText.js";
import { ExecutionSetSidebarRow } from "./ExecutionSetSidebarRow.js";
import type { SidebarExecutionSetsResult } from "@/hooks/useSidebarExecutionSets.js";

export function SidebarArchivePanel({
  props,
  queryTabs,
  bindings,
  sortBy,
  sets,
}: {
  props: UnifiedSidebarTreeProps;
  queryTabs: WorkspaceTabState[];
  bindings: WorktreeBinding[];
  sortBy: "created" | "updated";
  sets: SidebarExecutionSetsResult;
}) {
  const text = useSidebarText();
  const [source, setSource] = useState("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const archivedSets = sets.entries.filter(
    (entry) => entry.snapshot.status === "archived" || entry.snapshot.status === "restoring",
  );
  const [deletion, setDeletion] = useState<{ run(): void; enabled: boolean } | null>(null);
  const [refresh, setRefresh] = useState<(() => Promise<void>) | null>(null);
  const onRefresh = useCallback(
    (action: (() => Promise<void>) | null) => setRefresh(() => action),
    [],
  );
  const filter = useCallback(
    (task: LCodeTaskMeta) =>
      source !== "executionSets" &&
      (source === "all" || isWorktreeSidebarTask(task, bindings) === (source === "treeChats")),
    [source, bindings],
  );
  const actions = (
    Item: typeof DropdownMenuItem | typeof ContextMenuItem,
    Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator,
  ) => (
    <>
      <Item
        disabled={!refresh}
        onSelect={() => {
          void refresh?.();
          void sets.refresh();
        }}
      >
        <RefreshCw className="size-3.5" />
        {text("refreshArchive")}
      </Item>
      <Separator />
      <Item variant="destructive" disabled={!deletion?.enabled} onSelect={() => deletion?.run()}>
        <Trash2 className="size-3.5" />
        {text("deleteArchiveScope")}
      </Item>
    </>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <section
          id="sidebar-archive-panel"
          data-testid="sidebar-archive-panel"
          aria-label={text("archived")}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
        >
          <div className="flex items-center gap-1 py-2">
            <span className="pl-2 text-ui-xs text-foreground-subtlest">
              {text("archiveSource")}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost">
                  {text(source as "all")}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={source} onValueChange={setSource}>
                  {(
                    [
                      "all",
                      "ordinary",
                      "treeChats",
                      ...(archivedSets.length ? ["executionSets" as const] : []),
                    ] as const
                  ).map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {text(value)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto text-foreground-subtle"
                  aria-label={`${text("archived")} · ${text("more")}`}
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions(DropdownMenuItem, DropdownMenuSeparator)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {source === "all" || source === "executionSets"
            ? archivedSets.map((entry) => (
                <ExecutionSetSidebarRow
                  key={entry.snapshot.id}
                  entry={entry}
                  sets={sets}
                  open={Boolean(expanded[entry.snapshot.id])}
                  onToggle={() =>
                    setExpanded((previous) => ({
                      ...previous,
                      [entry.snapshot.id]: !previous[entry.snapshot.id],
                    }))
                  }
                  props={props}
                />
              ))
            : null}
          {source !== "executionSets" ? (
            <WorkspaceArchivedTasksFlatSection
              onDeleteActionChange={setDeletion}
              onRefreshActionChange={onRefresh}
              workspaceTabs={queryTabs}
              activeWorkspacePath={props.workspacePath}
              activeWorkspaceIdentity={props.workspaceIdentity}
              activeTaskId={props.activeTaskId}
              sortBy={sortBy}
              actionsContainer={null}
              taskFilter={filter}
              onSelectTask={props.onSelectTask}
            />
          ) : null}
        </section>
      </ContextMenuTrigger>
      <ContextMenuContent>{actions(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
    </ContextMenu>
  );
}
