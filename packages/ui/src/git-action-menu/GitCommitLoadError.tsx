import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitCommitLoadError({
  error,
  failureAction,
  onClose,
  onRetry,
}: {
  error: string | null;
  failureAction?: ReactNode;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-4 px-4 py-5">
      <p role="alert" className="break-words text-ui-base text-destructive">
        {error}
      </p>
      {failureAction}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {intl.formatMessage({ id: "common.close" })}
        </Button>
        <Button type="button" onClick={onRetry}>
          {intl.formatMessage({ id: "git.commitSummary.retry" })}
        </Button>
      </div>
    </div>
  );
}
