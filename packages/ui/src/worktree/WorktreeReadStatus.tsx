import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeReadStatus({
  loading,
  error,
}: {
  loading: boolean;
  error?: string | null;
}) {
  const { intl } = useLCodeIntl();
  if (error)
    return (
      <p role="alert" className="text-ui-sm text-destructive">
        {error}
      </p>
    );
  return loading ? <p role="status">{intl.formatMessage({ id: "worktree.loading" })}</p> : null;
}
