import { RefreshCw } from "lucide-react";
import type { GitBackupStatus } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBackupResultDetails } from "./GitBackupResultDetails.js";

export function GitBackupStatusPanel({
  status,
  busy,
  refresh,
}: {
  status: GitBackupStatus | null;
  busy: boolean;
  refresh: () => Promise<void>;
}) {
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
    <section
      className="min-w-0 space-y-4 border-t border-border pt-4"
      aria-labelledby="git-backup-status-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="git-backup-status-title" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.gitBackup.status" })}
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={busy}
          data-testid="git-backup-refresh"
        >
          <RefreshCw className="size-4" />
          {intl.formatMessage({ id: "settings.gitBackup.refresh" })}
        </Button>
      </div>
      {status ? (
        <>
          <div
            className="grid min-w-0 gap-2 text-ui-caption text-foreground-subtle sm:grid-cols-2"
            aria-live="polite"
          >
            <p>
              {intl.formatMessage({
                id: status.running
                  ? "settings.gitBackup.manualBackup.running"
                  : status.enabled
                    ? "settings.gitBackup.status.scheduled"
                    : "settings.gitBackup.status.disabled",
              })}
            </p>
            <p>
              {intl.formatMessage({
                id: status.configured
                  ? "settings.gitBackup.status.configured"
                  : "settings.gitBackup.status.notConfigured",
              })}
            </p>
            <p className="break-words sm:col-span-2">
              {intl.formatMessage(
                { id: "settings.gitBackup.status.nextBackup" },
                {
                  time: status.nextBackupAt
                    ? formatTime(status.nextBackupAt)
                    : intl.formatMessage({ id: "settings.gitBackup.status.notScheduled" }),
                },
              )}
            </p>
          </div>
          <GitBackupResultDetails result={status} />
        </>
      ) : (
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "settings.gitBackup.status.unknown" })}
        </p>
      )}
    </section>
  );
}
