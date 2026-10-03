import type { ReviewWorkspaceProjection } from "@/store/reviewWorkspaceState.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function ReviewWorkspaceSyncStatus({
  status,
  onRetry,
  onResolve,
}: {
  status: ReviewWorkspaceProjection["status"];
  onRetry: () => void;
  onResolve: (useLocal: boolean) => void;
}) {
  const { intl } = useLCodeIntl();
  if (status === "ready") return null;
  const text = (key: string) => intl.formatMessage({ id: `git.review.sync.${key}` });
  return (
    <div
      className="space-y-2 px-4 py-2 text-ui-sm text-foreground-subtle"
      role={status === "conflict" || status === "error" ? "alert" : "status"}
      data-testid="review-sync-status"
    >
      <p>{text(status)}</p>
      {status === "error" ? (
        <Button size="sm" variant="outline" type="button" onClick={onRetry}>
          {text("retry")}
        </Button>
      ) : null}
      {status === "conflict" ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" type="button" onClick={() => onResolve(false)}>
            {text("useHost")}
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => onResolve(true)}>
            {text("useLocal")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
