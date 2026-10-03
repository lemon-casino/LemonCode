import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export const REVIEW_FILE_PAGE_SIZE = 50;

export function useReviewFilePage<T>(files: readonly T[], path: (file: T) => string) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search ? files.filter((file) => path(file).toLocaleLowerCase().includes(search)) : files;
  }, [files, path, query]);
  const pages = Math.max(1, Math.ceil(matches.length / REVIEW_FILE_PAGE_SIZE));
  const index = Math.min(page, pages - 1);
  return {
    query,
    page: index,
    pages,
    total: files.length,
    matched: matches.length,
    files: matches.slice(index * REVIEW_FILE_PAGE_SIZE, (index + 1) * REVIEW_FILE_PAGE_SIZE),
    matchingFiles: matches,
    setQuery: (value: string) => {
      setQuery(value);
      setPage(0);
    },
    setPage,
  };
}

export function ReviewFilePagination({
  model,
  onNavigate,
}: {
  model: Pick<
    ReturnType<typeof useReviewFilePage>,
    "query" | "page" | "pages" | "total" | "matched" | "setQuery" | "setPage"
  >;
  onNavigate?: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-2 text-ui-sm" data-testid="review-file-pagination">
      <Input
        className="text-ui-sm"
        aria-label={intl.formatMessage({ id: "git.review.searchFiles" })}
        placeholder={intl.formatMessage({ id: "git.review.searchFiles" })}
        value={model.query}
        onChange={(e) => {
          model.setQuery(e.target.value);
          onNavigate?.();
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-foreground-subtle">
          {intl.formatMessage(
            { id: "git.review.filePage" },
            {
              total: model.total,
              matched: model.matched,
              current: model.page + 1,
              pages: model.pages,
            },
          )}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={model.page === 0}
          onClick={() => {
            model.setPage(model.page - 1);
            onNavigate?.();
          }}
        >
          {intl.formatMessage({ id: "git.review.previousPage" })}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={model.page + 1 >= model.pages}
          onClick={() => {
            model.setPage(model.page + 1);
            onNavigate?.();
          }}
        >
          {intl.formatMessage({ id: "git.review.nextPage" })}
        </Button>
      </div>
    </div>
  );
}
