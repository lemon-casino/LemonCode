import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useGitFailureHandoff } from "@/hooks/useGitFailureHandoff.js";
import { buildGitFailureDraft, type GitFailureContext } from "./gitFailureDraft.js";

export function GitFailureAction({
  workspacePath,
  workspaceIdentity,
  sessionId,
  context,
  disabled,
  onTransferred,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  context: GitFailureContext;
  disabled?: boolean;
  onTransferred?: () => void;
}) {
  const handoff = useGitFailureHandoff(workspacePath, workspaceIdentity, sessionId);
  const { intl, locale } = useLCodeIntl();
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        data-testid="git-failure-to-composer"
        disabled={disabled || !handoff.available}
        onClick={() => {
          if (!handoff.transfer(buildGitFailureDraft(context, locale))) {
            toast(intl.formatMessage({ id: "git.failure.composerUnavailable" }));
            return;
          }
          onTransferred?.();
        }}
      >
        {intl.formatMessage({ id: "git.failure.toComposer" })}
      </Button>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({
          id: handoff.available ? "git.failure.draftHint" : "git.failure.composerUnavailable",
        })}
      </p>
    </div>
  );
}
