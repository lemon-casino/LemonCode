import { useState } from "react";
import {
  Archive,
  ChevronRight,
  Layers,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type {
  SidebarExecutionSetEntry,
  SidebarExecutionSetsResult,
} from "@/hooks/useSidebarExecutionSets.js";
import { useExecutionSetDetails } from "@/hooks/useExecutionSetDetails.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import { SidebarPlacementItems } from "./SidebarPlacementItems.js";
import { SidebarSourceReadError } from "./SidebarSourceReadError.js";
import { ExecutionSetRepositoryRow } from "./ExecutionSetRepositoryRow.js";
import { ExecutionSetProgress } from "./ExecutionSetProgress.js";
import { executionSetRef } from "./sidebarReferences.js";
import { useSidebarText } from "./sidebarText.js";
import type { UnifiedSidebarTreeProps } from "./UnifiedSidebarTree.js";

export function ExecutionSetSidebarRow({
  entry,
  sets,
  open,
  onToggle,
  props,
}: {
  entry: SidebarExecutionSetEntry;
  sets: SidebarExecutionSetsResult;
  open: boolean;
  onToggle(): void;
  props: UnifiedSidebarTreeProps;
}) {
  const text = useSidebarText(),
    confirm = useConfirmDialog();
  const details = useExecutionSetDetails(entry, sets, open);
  const { snapshot, origin } = entry;
  const [renaming, setRenaming] = useState(false),
    [name, setName] = useState(snapshot.name);
  const ready = details.available && snapshot.status === "ready" && !details.pending;
  const archived = snapshot.status === "archived";
  const error = details.error || snapshot.error;
  const create = () => {
    if (ready)
      props.onCreateTask({
        targetWorkspace: origin,
        createSource: "project",
        executionSetId: snapshot.id,
      });
  };
  const archive = async () => {
    let acknowledged = false;
    if (
      await confirm({
        title: text("archiveExecutionSet"),
        description: `${snapshot.name}\n${text("archiveSetHint")}`,
        checkbox: {
          label: text("archiveIgnored"),
          onCheckedChange: (checked) => {
            acknowledged = checked;
          },
        },
        confirmLabel: text("archived"),
        cancelLabel: text("cancel"),
        showKeyboardHints: false,
        testId: "execution-set-archive-confirm",
      })
    )
      await details.run("archive", undefined, acknowledged);
  };
  const actions = (
    Item: typeof ContextMenuItem | typeof DropdownMenuItem,
    Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator,
  ) => (
    <>
      <Item disabled={!ready} onSelect={create} title={text("executionSetSharedHint")}>
        <Plus className="size-3.5" />
        {text("newChat")}
      </Item>
      <Item
        onSelect={() => {
          if (!open) onToggle();
        }}
      >
        <Layers className="size-3.5" />
        {text("viewExecutionSet")}
      </Item>
      <Item
        disabled={!details.available || details.pending}
        onSelect={() => {
          setName(snapshot.name);
          setRenaming(true);
        }}
      >
        <Pencil className="size-3.5" />
        {text("renameExecutionSet")}
      </Item>
      <Item
        disabled={!details.available || details.pending}
        onSelect={() => {
          void details.refresh();
          void sets.refresh(origin.workspaceIdentity || origin.workspacePath);
        }}
      >
        <RefreshCw className="size-3.5" />
        {text("reread")}
      </Item>
      <SidebarPlacementItems entry={executionSetRef(entry)} Item={Item} Separator={Separator} />
      <Separator />
      {snapshot.status === "failed" ||
      snapshot.status === "preparing" ||
      snapshot.status === "preflighting" ? (
        <Item
          disabled={!details.available || details.pending}
          onSelect={() => void details.run("retry")}
        >
          <RotateCcw className="size-3.5" />
          {text("retryExecutionSet")}
        </Item>
      ) : null}
      {archived || snapshot.status === "restoring" ? (
        <Item
          disabled={!details.available || details.pending}
          onSelect={() => void details.run("restore")}
        >
          <RotateCcw className="size-3.5" />
          {text("restoreExecutionSet")}
        </Item>
      ) : (
        <Item disabled={!details.available || details.pending} onSelect={() => void archive()}>
          <Archive className="size-3.5" />
          {text("archiveExecutionSet")}
        </Item>
      )}
    </>
  );
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="group flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-surface-hover"
            data-testid="sidebar-execution-set"
            data-execution-set-id={snapshot.id}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={snapshot.name}
            >
              <ChevronRight
                className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <Layers className="size-3.5 shrink-0 text-foreground-subtle" />
              <span className="min-w-0">
                <span className="block truncate text-ui-base">{snapshot.name}</span>
                <span className="block truncate text-ui-xs text-foreground-subtlest">
                  {origin.label} · {snapshot.repositories.length} {text("repositories")} ·{" "}
                  {details.available
                    ? text(`executionSetStatus_${snapshot.status}`)
                    : text("offline")}
                </span>
              </span>
            </button>
            {error ? (
              <SidebarSourceReadError
                label={snapshot.name}
                workspacePath={origin.workspacePath}
                error={error}
                refreshing={details.pending}
                onRefresh={() => {
                  void details.refresh();
                  void sets.refresh(origin.workspaceIdentity || origin.workspacePath);
                }}
              />
            ) : null}
            {details.pending ? (
              <LoaderCircle className="size-3.5 animate-spin text-foreground-subtle" />
            ) : null}
            <span className="flex shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-6"
                aria-label={text("newChat")}
                title={text("executionSetSharedHint")}
                disabled={!ready}
                onClick={create}
              >
                <Plus className="size-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="size-6"
                    aria-label={text("more")}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {actions(DropdownMenuItem, DropdownMenuSeparator)}
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{actions(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      {open ? (
        <div data-testid="execution-set-directories">
          <ExecutionSetProgress views={details.views} total={snapshot.repositories.length} />
          {snapshot.repositories.map((repository) => (
            <ExecutionSetRepositoryRow
              key={repository.id}
              entry={entry}
              repository={repository}
              view={details.views.find((view) => view.repositoryId === repository.id)}
              available={details.available}
              onRefresh={() => void details.refresh()}
              onOpenFileTree={props.onOpenFileTree}
            />
          ))}
        </div>
      ) : null}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{text("renameExecutionSet")}</DialogTitle>
            <DialogDescription>{snapshot.name}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            maxLength={120}
            disabled={details.pending}
            onChange={(event) => setName(event.target.value)}
          />
          {details.error ? (
            <p role="alert" className="break-words text-ui-sm text-destructive">
              {details.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>
              {text("cancel")}
            </Button>
            <Button
              disabled={details.pending || !name.trim()}
              onClick={() =>
                void details.run("rename", name.trim()).then((saved) => {
                  if (saved) setRenaming(false);
                })
              }
            >
              {text("saveChanges")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
