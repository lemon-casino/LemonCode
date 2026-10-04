import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitMergeReviewContent({
  canOpenFiles,
  onOpenFiles,
  children,
}: {
  canOpenFiles: boolean;
  onOpenFiles: () => void;
  children: ReactNode;
}) {
  const { intl } = useLCodeIntl();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mx-4 my-3"
        data-testid="git-merge-open-source-files"
        disabled={!canOpenFiles}
        onClick={onOpenFiles}
      >
        {intl.formatMessage({ id: "git.review.viewSourceFiles" })}
      </Button>
      <div className="px-4 pb-3">{children}</div>
    </>
  );
}
