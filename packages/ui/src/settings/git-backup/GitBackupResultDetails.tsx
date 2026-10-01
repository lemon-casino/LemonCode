import type { GitBackupDestinationStatus, GitBackupStatus } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

type BackupResult = Pick<
  GitBackupStatus,
  "lastBackupAt" | "lastBackupFiles" | "lastBackupSize" | "lastWorkspacePath" | "error"
> &
  Partial<Pick<GitBackupDestinationStatus, "lastAttemptAt">>;

export function GitBackupResultDetails({ result }: { result: BackupResult }) {
  const { intl, locale } = useLCodeIntl();
  const formatTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(date);
  };
  return (
    <div
      className="grid min-w-0 gap-2 text-ui-caption text-foreground-subtle sm:grid-cols-2"
      aria-live="polite"
    >
      {result.lastAttemptAt ? (
        <p className="break-words sm:col-span-2">
          {intl.formatMessage(
            { id: "settings.gitBackup.status.lastAttempt" },
            { time: formatTime(result.lastAttemptAt) },
          )}
        </p>
      ) : null}
      <p className="break-words sm:col-span-2">
        {result.lastBackupAt
          ? intl.formatMessage(
              { id: "settings.gitBackup.status.lastBackup" },
              { time: formatTime(result.lastBackupAt) },
            )
          : intl.formatMessage({ id: "settings.gitBackup.status.neverBackedUp" })}
      </p>
      {result.lastBackupAt ? (
        <>
          <p>
            {intl.formatMessage(
              { id: "settings.gitBackup.status.lastBackupFiles" },
              { count: result.lastBackupFiles },
            )}
          </p>
          <p>
            {intl.formatMessage(
              { id: "settings.gitBackup.status.lastBackupSize" },
              {
                size: `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result.lastBackupSize / 1024 / 1024)} MiB`,
              },
            )}
          </p>
        </>
      ) : null}
      {result.lastWorkspacePath ? (
        <p className="break-all sm:col-span-2">
          {intl.formatMessage(
            { id: "settings.gitBackup.status.lastWorkspace" },
            { path: result.lastWorkspacePath },
          )}
        </p>
      ) : null}
      {result.error ? (
        <p role="alert" className="break-words text-destructive sm:col-span-2">
          {intl.formatMessage({ id: "settings.gitBackup.status.error" }, { error: result.error })}
        </p>
      ) : null}
    </div>
  );
}
