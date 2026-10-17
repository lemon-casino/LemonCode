import { GitBranch, FolderOpen, Copy, Settings2 } from "lucide-react";
import type { ExecutionSetSnapshot, ExecutionSetRepositoryView } from "@lcode/shared";
import { replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import type { SidebarExecutionSetEntry } from "@/hooks/useSidebarExecutionSets.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useOpenWorktreeSettings } from "@/hooks/useOpenWorktreeSettings.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu.js";
import { SidebarSourceReadError } from "./SidebarSourceReadError.js";
import { useSidebarText } from "./sidebarText.js";
import type { WorktreeFileTarget } from "./WorktreeSidebarRow.js";
import { ExecutionSetIntegrationStatus } from "./ExecutionSetProgress.js";

export function ExecutionSetRepositoryRow({
  entry,
  repository,
  view,
  available,
  onRefresh,
  onOpenFileTree,
}: {
  entry: SidebarExecutionSetEntry;
  repository: ExecutionSetSnapshot["repositories"][number];
  view?: ExecutionSetRepositoryView;
  available: boolean;
  onRefresh(): void;
  onOpenFileTree?(target: WorktreeFileTarget): void;
}) {
  const text = useSidebarText(),
    openSettings = useOpenWorktreeSettings();
  const { copyAbsolutePath } = useFileContextActions();
  const binding = view?.binding,
    error = view?.error || repository.error || binding?.error || view?.integration?.error;
  const name =
    repository.repositoryRoot.split(/[\\/]/).filter(Boolean).at(-1) || repository.repositoryRoot;
  const scope = {
    workspacePath: repository.repositoryRoot,
    workspaceIdentity: entry.origin.workspaceIdentity
      ? (replaceRemoteWorkspaceIdentityPath(
          entry.origin.workspaceIdentity,
          repository.repositoryRoot,
        ) ?? undefined)
      : undefined,
  };
  const open = () => {
    if (binding && available)
      onOpenFileTree?.({
        workspacePath: binding.checkoutPath,
        workspaceIdentity: binding.workspaceIdentity
          ? (replaceRemoteWorkspaceIdentityPath(binding.workspaceIdentity, binding.checkoutPath) ??
            undefined)
          : undefined,
        workspaceRemoteSessionId: entry.origin.remoteSessionId,
        workspaceName: name,
      });
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="group ml-5 flex min-w-0 items-center gap-2 rounded-md border-l border-border px-2 py-1.5 hover:bg-surface-hover"
          data-testid="execution-set-repository"
          onContextMenu={(event) => event.stopPropagation()}
        >
          <GitBranch className="size-3.5 shrink-0 text-foreground-subtle" />
          <button
            className="min-w-0 flex-1 text-left"
            type="button"
            disabled={!available || binding?.status !== "ready"}
            onClick={open}
            title={binding?.checkoutPath ?? repository.repositoryRoot}
          >
            <span className="block truncate text-ui-sm">{name}</span>
            <span className="block truncate font-mono text-ui-xs text-foreground-subtlest">
              {binding?.branch ?? repository.baseRef}
            </span>
            {view ? <ExecutionSetIntegrationStatus view={view} /> : null}
          </button>
          {error ? (
            <SidebarSourceReadError
              label={name}
              workspacePath={repository.repositoryRoot}
              error={error}
              onRefresh={onRefresh}
            />
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
            disabled={!binding || !available}
            aria-label={text("manage")}
            title={text("ownedBySet")}
            onClick={() => binding && openSettings({ ...scope, bindingId: binding.id })}
          >
            <Settings2 className="size-3.5" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!binding || !available || binding.status !== "ready"}
          onSelect={open}
        >
          <FolderOpen className="size-3.5" />
          {text("files")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!binding}
          onSelect={() =>
            binding && void copyAbsolutePath({ path: binding.checkoutPath, kind: "directory" })
          }
        >
          <Copy className="size-3.5" />
          {text("copyPath")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!binding || !available}
          title={text("ownedBySet")}
          onSelect={() => binding && openSettings({ ...scope, bindingId: binding.id })}
        >
          <Settings2 className="size-3.5" />
          {text("manage")}
        </ContextMenuItem>
        <ContextMenuItem disabled>{text("ownedBySet")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
