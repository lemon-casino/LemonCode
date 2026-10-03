import { useState } from "react";
import type { GitRepositorySummary } from "@lcode/shared";
import { GitBranchIcon, LoaderIcon, Settings2Icon } from "lucide-react";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeCapabilities } from "@/hooks/useWorktreeCapabilities.js";
import { useWorktreeBaseBranches } from "@/hooks/useWorktreeBaseBranches.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ProjectExecutionPolicySettings } from "./ExecutionPolicySettings.js";

export function DraftWorkspaceExecutionControls({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  dirtyFileCount,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  dirtyFileCount: number;
  onRefreshGit: () => void;
}) {
  const { intl } = useLCodeIntl();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const selection = useDraftExecutionStore((store) => store.drafts[scope]);
  const choose = useDraftExecutionStore((store) => store.choose);
  const retry = useDraftExecutionStore((store) => store.retry);
  const { policy, loading } = useProjectExecutionPolicy(
    workspacePath,
    workspaceIdentity,
    selection?.mode,
  );
  const [baseOpen, setBaseOpen] = useState(false);
  const branches = useWorktreeBaseBranches(workspacePath, workspaceIdentity, baseOpen);
  const pending = Boolean(selection?.requestId);
  const frozen = pending || selection?.frozen;
  const worktree = policy.executionMode === "worktree";
  const capability = useWorktreeCapabilities(
    workspacePath,
    workspaceIdentity,
    gitSummary.branchName ?? gitSummary.headRefType,
  );
  const supportedRepository =
    gitSummary.isGitAvailable &&
    gitSummary.isRepository &&
    capability.capabilities?.supported === true &&
    capability.capabilities.create;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-testid="draft-execution-controls"
    >
      <Select
        value={policy.executionMode}
        disabled={frozen || loading}
        onValueChange={(mode) => choose(scope, { mode: mode as "local" | "worktree" })}
      >
        <SelectTrigger
          data-testid="draft-execution-mode"
          aria-label={intl.formatMessage({ id: "worktree.executionMode" })}
          className="h-7 w-auto gap-1 border-0 bg-transparent px-1 text-ui-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{intl.formatMessage({ id: "worktree.mode.local" })}</SelectItem>
          <SelectItem value="worktree" disabled={!supportedRepository}>
            {intl.formatMessage({ id: "worktree.mode.worktree" })}
          </SelectItem>
        </SelectContent>
      </Select>
      {worktree ? (
        <Popover open={baseOpen && !frozen} onOpenChange={setBaseOpen}>
          <PopoverTrigger asChild>
            <Button
              data-testid="worktree-base-trigger"
              variant="ghost"
              size="sm"
              className="h-7 min-w-0 gap-1 px-1 text-ui-sm"
              disabled={frozen || !supportedRepository}
            >
              <GitBranchIcon className="size-4 shrink-0" />
              <span className="truncate">
                {intl.formatMessage({ id: "worktree.base" })}:{" "}
                {selection?.baseRef ?? gitSummary.branchName ?? "HEAD"}
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            className="max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto p-2"
          >
            <p className="px-2 pb-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "worktree.baseDescription" })}
            </p>
            {branches.loading ? (
              <LoaderIcon className="m-2 size-4 animate-spin" />
            ) : branches.error ? (
              <div role="alert" className="p-2 text-ui-sm text-destructive">
                {branches.error}
                <Button variant="ghost" size="sm" onClick={() => void branches.refresh()}>
                  {intl.formatMessage({ id: "worktree.retry" })}
                </Button>
              </div>
            ) : (
              <>
                <Button
                  variant="ghost"
                  className="w-full justify-start text-ui-sm"
                  onClick={() => {
                    choose(scope, { baseRef: undefined });
                    setBaseOpen(false);
                  }}
                >
                  HEAD
                </Button>
                {branches.result?.branches.map((branch) => (
                  <Button
                    key={branch.name}
                    variant="ghost"
                    className="w-full justify-start truncate text-ui-sm"
                    onClick={() => {
                      choose(scope, { baseRef: branch.name });
                      setBaseOpen(false);
                    }}
                  >
                    {branch.name}
                  </Button>
                ))}
              </>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={gitSummary}
          dirtyFileCount={dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="px-0 pt-0"
          popoverClassName="w-72"
          branchListClassName="max-h-48"
          avoidPopoverCollisions={false}
        />
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "worktree.projectSettings" })}
            data-testid="project-execution-settings"
          >
            <Settings2Icon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-96 max-w-[calc(100vw-2rem)]">
          <ProjectExecutionPolicySettings
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
          />
        </PopoverContent>
      </Popover>
      {pending ? (
        <span role="status" className="flex items-center gap-1 text-ui-sm text-foreground-subtle">
          <LoaderIcon className="size-3 animate-spin" />
          {intl.formatMessage({ id: "worktree.preparing" })}
        </span>
      ) : selection?.error ? (
        <span role="alert" className="max-w-full break-words text-ui-sm text-destructive">
          {selection.error}
          <Button type="button" variant="ghost" size="sm" onClick={() => retry(scope)}>
            {intl.formatMessage({ id: "worktree.retry" })}
          </Button>
        </span>
      ) : worktree && !supportedRepository ? (
        <span role="alert" className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "worktree.unavailable" })}
        </span>
      ) : null}
    </div>
  );
}
