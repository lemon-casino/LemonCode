import type { WorktreeBinding } from "@lcode/services";
import { GitMergeIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WorktreeTargetSelect } from "./WorktreeTargetSelect.js";

export function WorktreePreparation({
  binding,
  targetBranch,
  commands,
  locked,
  activeIntegration,
  commandsLocked,
  onCommands,
  onTarget,
  onRestore,
  onIntegrate,
}: {
  binding: WorktreeBinding;
  targetBranch: string;
  commands: string;
  locked: boolean;
  activeIntegration: boolean;
  commandsLocked: boolean;
  onCommands: (commands: string) => void;
  onTarget: (branch: string) => void;
  onRestore: () => void;
  onIntegrate: () => void;
}) {
  const { intl } = useLCodeIntl();
  if (binding.status === "archived")
    return (
      <Button type="button" disabled={locked} onClick={onRestore}>
        {intl.formatMessage({ id: "worktree.restore" })}
      </Button>
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
      <label className="space-y-1 text-ui-sm">
        <span>{intl.formatMessage({ id: "worktree.validationCommands" })}</span>
        <Textarea
          value={commands}
          onChange={(event) => onCommands(event.target.value)}
          disabled={locked || commandsLocked}
          className="font-mono text-ui-sm"
          placeholder={intl.formatMessage({ id: "worktree.validationCommandsHint" })}
        />
      </label>
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
