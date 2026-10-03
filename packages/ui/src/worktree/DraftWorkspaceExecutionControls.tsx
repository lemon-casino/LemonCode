import { useState } from "react";
import {
  GitBranchDeleteButton,
  GitBranchDeletionDialog,
} from "@/git-branch-switcher/GitBranchDeletionDialog.js";
import type { GitLocalBranch, GitRepositorySummary } from "@lcode/shared";
import { GitBranchIcon, LoaderIcon, Settings2Icon } from "lucide-react";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useWorktreeCapabilities } from "@/hooks/useWorktreeCapabilities.js";
import { useWorktreeBaseBranches } from "@/hooks/useWorktreeBaseBranches.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
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
  const { policy, loading, update } = useProjectExecutionPolicy(
    workspacePath,
    workspaceIdentity,
    // 合并执行方式入口后，只有已接受请求的冻结意图可覆盖项目设置，避免旧草稿值造成双重默认。
    selection?.frozen ? selection.mode : undefined,
  );
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState<{ scope: string; message: string } | null>(null);
  const saveMode = async (mode: "local" | "worktree") => {
    setSavingMode(true);
    setModeError(null);
    try {
      await update({ projectExecutionPreferences: { [scope]: { executionMode: mode } } });
    } catch (reason) {
      setModeError({ scope, message: getErrorMessage(reason) });
    } finally {
      setSavingMode(false);
    }
  };
  const [baseOpen, setBaseOpen] = useState(false);
  const [deletingBranch, setDeletingBranch] = useState<{
    scope: string;
    branch: GitLocalBranch;
  } | null>(null);
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
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
      data-testid="draft-execution-controls"
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-testid="draft-execution-location"
      >
        <Select
          value={policy.executionMode}
          disabled={frozen || loading || savingMode}
          onValueChange={(mode) => void saveMode(mode as "local" | "worktree")}
        >
          <SelectTrigger
            data-testid="draft-execution-mode"
            aria-label={intl.formatMessage({ id: "worktree.executionMode" })}
            title={intl.formatMessage({ id: "worktree.executionModeDescription" })}
            className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent px-1 text-ui-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" className="max-w-[calc(100vw-2rem)]">
            <div className="max-w-72 space-y-1 px-2 py-1.5 text-ui-sm text-foreground-subtle">
              <p>{intl.formatMessage({ id: "worktree.executionModeDescription" })}</p>
              <p data-testid="draft-execution-mode-source">
                {intl.formatMessage({
                  id: `worktree.draftModeSource.${policy.sources.executionMode}`,
                })}
              </p>
            </div>
            <SelectItem value="local">
              {intl.formatMessage({ id: "worktree.mode.local" })}
            </SelectItem>
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
                className="h-7 min-w-0 max-w-full shrink gap-1 px-1 text-ui-sm"
                disabled={frozen || !supportedRepository}
              >
                <GitBranchIcon className="size-4 shrink-0" />
                <span
                  className="truncate"
                  title={selection?.baseRef ?? gitSummary.branchName ?? "HEAD"}
                >
                  {intl.formatMessage({ id: "worktree.base" })}:{" "}
                  {selection?.baseRef ?? gitSummary.branchName ?? "HEAD"}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
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
                    <div key={branch.name} className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        className="w-full justify-start truncate text-ui-sm"
                        onClick={() => {
                          choose(scope, { baseRef: branch.name });
                          setBaseOpen(false);
                        }}
                      >
                        {branch.name}
                      </Button>
                      <GitBranchDeleteButton
                        branch={branch}
                        disabled={frozen}
                        onRequest={(selected) => {
                          setDeletingBranch({ scope, branch: selected });
                          setBaseOpen(false);
                        }}
                      />
                    </div>
                  ))}
                </>
              )}
            </PopoverContent>
          </Popover>
        ) : (
          <GitBranchSwitcher
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            gitSummary={gitSummary}
            dirtyFileCount={dirtyFileCount}
            onRefreshGit={onRefreshGit}
            className="min-w-0 px-0 pt-0"
            triggerClassName="min-w-0 max-w-full"
            popoverClassName="w-72 max-w-[calc(100vw-2rem)]"
            branchListClassName="max-h-48"
          />
        )}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0"
            aria-label={intl.formatMessage({ id: "worktree.projectSettings" })}
            data-testid="project-execution-settings"
          >
            <Settings2Icon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-96 max-w-[calc(100vw-2rem)]">
          <ProjectExecutionPolicySettings
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
          />
        </PopoverContent>
      </Popover>
      <GitBranchDeletionDialog
        key={scope}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        branch={deletingBranch?.scope === scope ? deletingBranch.branch : null}
        onClose={() => setDeletingBranch(null)}
        onDeleted={(name) => {
          setDeletingBranch(null);
          if (selection?.baseRef === name) choose(scope, { baseRef: undefined });
          void branches.refresh();
          onRefreshGit();
        }}
      />
      {modeError?.scope === scope ? (
        <span role="alert" className="basis-full break-words text-ui-sm text-destructive">
          {modeError.message}
        </span>
      ) : null}
      {worktree && !supportedRepository ? (
        <span role="alert" className="text-ui-sm text-warning">
          {intl.formatMessage({ id: "worktree.unavailable" })}
        </span>
      ) : null}
    </div>
  );
}
