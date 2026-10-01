import { RefreshCw, Trash2 } from "lucide-react";
import {
  gitBackupWorkspaceKey,
  type GitBackupStatus,
  type GitBackupWorkspaceTarget,
} from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBackupResultDetails } from "./GitBackupResultDetails.js";

export function GitBackupStatusPanel({
  status,
  workspaces,
  target,
  busy,
  refresh,
  remove,
}: {
  status: GitBackupStatus | null;
  workspaces: GitBackupWorkspaceTarget[];
  target: GitBackupWorkspaceTarget | null;
  busy: boolean;
  refresh: () => Promise<void>;
  remove: (target: GitBackupWorkspaceTarget) => Promise<void>;
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
      <h3 className="text-ui-base font-medium">
        {intl.formatMessage({ id: "settings.gitBackup.workspaces" })}
      </h3>
      {workspaces.length ? (
        <ul className="divide-y divide-border">
          {workspaces.map((workspace) => {
            const current =
              target && gitBackupWorkspaceKey(workspace) === gitBackupWorkspaceKey(target);
            return (
              <li
                key={gitBackupWorkspaceKey(workspace)}
                className="flex min-w-0 items-start justify-between gap-3 py-2"
              >
                <div className="min-w-0 text-ui-caption">
                  <p className="break-all font-mono">{workspace.workspacePath}</p>
                  {workspace.workspaceIdentity ? (
                    <p className="break-all text-foreground-subtle">
                      {workspace.workspaceIdentity}
                    </p>
                  ) : null}
                  {current ? (
                    <p className="text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.gitBackup.currentWorkspace" })}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  onClick={() => void remove(workspace)}
                  aria-label={intl.formatMessage(
                    { id: "settings.gitBackup.removeWorkspace" },
                    { path: workspace.workspacePath },
                  )}
                  title={intl.formatMessage({ id: "settings.gitBackup.remove" })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "settings.gitBackup.workspacesEmpty" })}
        </p>
      )}
    </section>
  );
}
