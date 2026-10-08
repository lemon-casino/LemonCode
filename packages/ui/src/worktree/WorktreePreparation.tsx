import type { WorktreeBinding } from "@lcode/services";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useWorktreeIntegrationPreflight } from "@/hooks/useWorktreeIntegrationPreflight.js";
import { ReviewActionBar } from "@/git-action-menu/ReviewActionBar.js";
import { GitMergeIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WorktreeTargetSelect } from "./WorktreeTargetSelect.js";

export function WorktreePreparation({
  binding,
  targetBranch,
  commands,
  locked,
  activeIntegration,
  onTarget,
  onIntegrate,
  acknowledgedKey,
  onAcknowledge,
}: {
  binding: WorktreeBinding;
  targetBranch: string;
  commands: string;
  locked: boolean;
  activeIntegration: boolean;
  onTarget: (branch: string) => void;
  onIntegrate: (acknowledgeUncommitted: boolean) => void;
  acknowledgedKey: string | null;
  onAcknowledge: (key: string | null) => void;
}) {
  const { intl } = useLCodeIntl();
  const preview = useWorktreeIntegrationPreflight(binding.id, targetBranch);
  const previewKey = JSON.stringify(preview.value);
  const hasUncommitted = Boolean(preview.value?.uncommittedFileCount);
  const acknowledged = acknowledgedKey === previewKey;
  if (binding.status === "archived")
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.restoreFromManagement" })}
      </p>
    );
  return (
    <>
      <WorktreeTargetSelect
        workspacePath={binding.originalWorkspacePath}
        workspaceIdentity={binding.originalWorkspaceIdentity}
        value={targetBranch}
        onChange={onTarget}
        disabled={locked || activeIntegration}
      />
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.preparation.automaticValidation" })}
      </p>
      <div
        className="space-y-2 rounded-xl border border-card-border bg-surface p-3 text-ui-sm"
        data-testid="worktree-preflight"
      >
        {preview.value ? (
          <>
            <p>
              {intl.formatMessage(
                {
                  id: preview.value.alreadyContained
                    ? "worktree.preflight.contained"
                    : "worktree.preflight.commits",
                },
                { count: preview.value.sourceCommitCount },
              )}
            </p>
            {hasUncommitted ? (
              <>
                <p className="text-warning">
                  {intl.formatMessage(
                    { id: "worktree.preflight.uncommitted" },
                    { count: preview.value.uncommittedFileCount },
                  )}
                </p>
                <label className="flex items-start gap-2 leading-6">
                  <Checkbox
                    className="mt-1"
                    data-testid="worktree-exclude-uncommitted"
                    checked={acknowledged}
                    disabled={locked || activeIntegration}
                    onCheckedChange={(value) => onAcknowledge(value === true ? previewKey : null)}
                  />
                  <span>{intl.formatMessage({ id: "worktree.preflight.exclude" })}</span>
                </label>
              </>
            ) : null}
          </>
        ) : (
          <p role={preview.error ? "alert" : "status"}>
            {preview.error ?? intl.formatMessage({ id: "worktree.preflight.loading" })}
          </p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={preview.loading || locked}
          onClick={preview.refresh}
        >
          {intl.formatMessage({ id: "worktree.refresh" })}
        </Button>
      </div>
      {commands.trim() ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
          {commands}
        </pre>
      ) : null}
      <ReviewActionBar>
        <Button
          type="button"
          data-testid="worktree-integrate"
          className="h-auto min-h-8 max-w-full whitespace-normal rounded-lg"
          disabled={
            locked ||
            binding.status !== "ready" ||
            activeIntegration ||
            preview.loading ||
            Boolean(preview.error) ||
            (hasUncommitted && !acknowledged)
          }
          onClick={() => onIntegrate(hasUncommitted && acknowledged)}
        >
          <GitMergeIcon className="size-4" />
          {intl.formatMessage({
            id:
              preview.value?.alreadyContained && !hasUncommitted
                ? "worktree.preflight.finish"
                : "worktree.integrate",
          })}
        </Button>
      </ReviewActionBar>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.integrateDescription" })}
      </p>
    </>
  );
}
