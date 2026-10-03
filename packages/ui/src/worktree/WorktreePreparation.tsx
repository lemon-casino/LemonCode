import type { WorktreeBinding } from "@lcode/services";
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
}: {
  binding: WorktreeBinding;
  targetBranch: string;
  commands: string;
  locked: boolean;
  activeIntegration: boolean;
  onTarget: (branch: string) => void;
  onIntegrate: () => void;
}) {
  const { intl } = useLCodeIntl();
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
      {commands.trim() ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
          {commands}
        </pre>
      ) : null}
      <Button
        type="button"
        data-testid="worktree-integrate"
        variant="outline"
        disabled={locked || binding.status !== "ready" || activeIntegration}
        onClick={onIntegrate}
      >
        <GitMergeIcon className="size-4" />
        {intl.formatMessage({ id: "worktree.integrate" })}
      </Button>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.integrateDescription" })}
      </p>
    </>
  );
}
