import { useMemo, useState, type ReactNode } from "react";
import type { PatchCodeViewerSource, ReviewPreviewFile } from "@/lib/codeViewer.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useReviewDiffNavigationStore } from "@/store/reviewDiffNavigationStore.js";
import { useReviewFileDiff } from "@/hooks/useReviewFileDiff.js";
import { ReviewDiffReturnButton } from "./ReviewDiffReturnButton.js";
import { ReviewFilePagination, useReviewFilePage } from "./ReviewFilePagination.js";

const pathOf = (file: ReviewPreviewFile) => file.path;

export function ReviewFileWorkspace({
  source,
  renderDiff,
}: {
  source: PatchCodeViewerSource;
  renderDiff: (source: PatchCodeViewerSource) => ReactNode;
}) {
  const { intl } = useLCodeIntl();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const files = source.reviewFiles ?? [];
  const page = useReviewFilePage(files, pathOf);
  const file = useMemo(
    () => files.find((item) => item.path === selectedPath) ?? page.files[0],
    [files, selectedPath, page.files],
  );
  const entry = useReviewDiffNavigationStore((state) =>
    source.reviewReturnToken ? state.returns[source.reviewReturnToken] : undefined,
  );
  const actions = entry?.files?.();
  const excluded = useMemo(() => new Set(actions?.excludedFiles ?? []), [actions?.excludedFiles]);
  const diff = useReviewFileDiff(source, source.reviewMetadataOnly ? undefined : file);
  const text = (id: string) => intl.formatMessage({ id: `git.review.${id}` });
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="review-file-workspace"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-ui-sm">
        <span className="min-w-0 flex-1 font-medium">{source.title}</span>
        <ReviewDiffReturnButton token={source.reviewReturnToken} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div
          className={
            source.reviewMetadataOnly
              ? "min-h-0 flex-1 space-y-2 overflow-auto p-3"
              : "max-h-[45%] shrink-0 space-y-2 overflow-auto border-b border-border p-3 md:max-h-none md:w-72 md:border-b-0 md:border-r"
          }
        >
          <ReviewFilePagination model={page} />
          {actions && !source.reviewMetadataOnly ? (
            <div className="space-y-2 text-ui-sm">
              <p>
                {intl.formatMessage(
                  { id: "git.review.scopeCounts" },
                  {
                    selected: files.length - files.filter((item) => excluded.has(item.path)).length,
                    excluded: excluded.size,
                    total: files.length,
                  },
                )}
              </p>
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-testid="review-exclude-page"
                  disabled={
                    actions.disabled || !page.files.some((item) => !excluded.has(item.path))
                  }
                  onClick={() =>
                    actions.exclude(
                      page.files.filter((item) => !excluded.has(item.path)).map(pathOf),
                    )
                  }
                >
                  {text("excludePage")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  data-testid="review-restore-all"
                  disabled={actions.disabled || !excluded.size}
                  onClick={() => actions.restore([...excluded])}
                >
                  {text("restoreAll")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-auto min-h-7 whitespace-normal"
                  data-testid="review-exclude-matching"
                  disabled={
                    actions.disabled ||
                    !page.query.trim() ||
                    !page.matchingFiles.some((item) => !excluded.has(item.path))
                  }
                  onClick={() =>
                    actions.exclude(
                      page.matchingFiles.filter((item) => !excluded.has(item.path)).map(pathOf),
                    )
                  }
                >
                  {intl.formatMessage(
                    { id: "git.review.excludeMatching" },
                    { count: page.matched },
                  )}
                </Button>
              </div>
              {excluded.size ? (
                <p className="text-warning">{text("regenerationRequired")}</p>
              ) : null}
            </div>
          ) : null}
          <ul className="space-y-1 text-ui-sm" data-testid="review-workspace-files">
            {page.files.map((item) => (
              <li key={item.path} className="min-w-0 rounded-lg border border-border p-2">
                <button
                  type="button"
                  className="w-full break-all text-left font-mono"
                  aria-current={file?.path === item.path ? "true" : undefined}
                  onClick={() => setSelectedPath(item.path)}
                >
                  {item.path}
                </button>
                {excluded.has(item.path) ? (
                  <span className="text-warning"> {text("excluded")}</span>
                ) : null}
                {actions && !source.reviewMetadataOnly ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid={`git-review-${excluded.has(item.path) ? "restore" : "exclude"}-${item.path}`}
                    disabled={actions.disabled}
                    onClick={() =>
                      excluded.has(item.path)
                        ? actions.restore([item.path])
                        : actions.exclude([item.path])
                    }
                  >
                    {text(excluded.has(item.path) ? "restoreFile" : "exclude")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
        {!source.reviewMetadataOnly ? (
          <div className="min-h-0 min-w-0 flex-1">
            {file?.patch === undefined ? (
              <p className="px-3 py-1 text-ui-sm text-warning">{text("liveDiff")}</p>
            ) : null}
            {diff.loading ? (
              <p role="status" className="p-3 text-ui-sm">
                {text("loadingDiff")}
              </p>
            ) : diff.error ? (
              <p role="alert" className="p-3 text-ui-sm text-warning">
                {diff.error}
              </p>
            ) : file ? (
              renderDiff({
                ...source,
                reviewFiles: undefined,
                reviewReturnToken: undefined,
                path: file.path,
                title: file.path,
                patch: diff.patch,
              })
            ) : (
              <p className="p-3 text-ui-sm">{text("noFiles")}</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
