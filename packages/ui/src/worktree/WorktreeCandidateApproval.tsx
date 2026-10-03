import type { WorktreeIntegration } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeCandidateApproval({
  operation,
  locked,
  approvedHead,
  skipValidation,
  canPublish,
  onApprove,
  onSkip,
  onValidate,
  onPublish,
}: {
  operation: WorktreeIntegration;
  locked: boolean;
  approvedHead: string | null;
  skipValidation: boolean;
  canPublish: boolean;
  onApprove: (head: string | null) => void;
  onSkip: (skip: boolean) => void;
  onValidate: () => void;
  onPublish: () => void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `worktree.${key}` });
  if (
    !operation.candidateHead ||
    !["awaiting-review", "ready", "validation-failed", "publishing"].includes(operation.status)
  )
    return null;
  return (
    <>
      <label className="flex items-start gap-2 text-ui-sm">
        <Checkbox
          data-testid="worktree-approve-candidate"
          disabled={locked}
          checked={approvedHead === operation.candidateHead}
          onCheckedChange={(checked) =>
            onApprove(checked === true ? operation.candidateHead! : null)
          }
        />
        <span>{text("approveCandidate")}</span>
      </label>
      {!operation.validationCommands.length ? (
        <label className="flex items-start gap-2 text-ui-sm">
          <Checkbox
            disabled={locked}
            checked={skipValidation}
            onCheckedChange={(checked) => onSkip(checked === true)}
          />
          <span>{text("noValidation")}</span>
        </label>
      ) : null}
      {operation.status === "awaiting-review" || operation.status === "validation-failed" ? (
        <Button
          type="button"
          data-testid="worktree-validate"
          disabled={
            locked ||
            approvedHead !== operation.candidateHead ||
            (!operation.validationCommands.length && !skipValidation)
          }
          onClick={onValidate}
        >
          {text("validate")}
        </Button>
      ) : (
        <Button
          type="button"
          data-testid="worktree-publish"
          disabled={locked || !canPublish}
          onClick={onPublish}
        >
          {intl.formatMessage(
            {
              id: operation.status === "publishing" ? "worktree.retryPublish" : "worktree.publish",
            },
            { branch: operation.targetBranch },
          )}
        </Button>
      )}
    </>
  );
}
