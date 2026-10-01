import { useId } from "react";
import { HardDriveUpload, PlugZap, RotateCcw, Save } from "lucide-react";
import { getGitBackupDestinationSelection, type GitBackupWorkspaceTarget } from "@lcode/services";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import type { useGitBackup } from "@/hooks/useGitBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBackupDestinationFields } from "./GitBackupDestinationFields.js";
import { GitBackupResultDetails } from "./GitBackupResultDetails.js";

export function GitBackupDestinationPanel({
  backup,
  target,
  formId,
}: {
  backup: ReturnType<typeof useGitBackup>;
  target: GitBackupWorkspaceTarget | null;
  formId: string;
}) {
  const { intl } = useLCodeIntl();
  const enabledId = useId();
  const { config, provider, status } = backup;
  if (!config) return null;
  const busy = Boolean(backup.operation);
  const enabled = getGitBackupDestinationSelection(config)[provider];
  const name = intl.formatMessage({ id: `settings.gitBackup.provider.${provider}` });
  const destination = status?.destinations?.[provider];
  const configured = destination?.configured ?? (provider === "oss" && status?.configured);
  return (
    <div className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h4 className="text-ui-base font-medium">{name}</h4>
          <label htmlFor={enabledId} className="block text-ui-caption text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.gitBackup.destinationEnabled" },
              { provider: name },
            )}
          </label>
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "settings.gitBackup.destinationEnabled.note" })}
          </p>
        </div>
        <Switch
          id={enabledId}
          data-testid={`git-backup-${provider}-enabled`}
          checked={enabled}
          disabled={busy || (!enabled && !backup.canEnableDestination(provider))}
          onCheckedChange={(selected) => void backup.setDestinationEnabled(provider, selected)}
        />
      </div>
      <form
        id={formId}
        className="min-w-0 space-y-4 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void backup.save();
        }}
      >
        <GitBackupDestinationFields backup={backup} busy={busy} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={busy || !target} data-testid="git-backup-save">
            <Save className="size-4" />
            {intl.formatMessage(
              {
                id:
                  backup.operation === "save"
                    ? "settings.gitBackup.saving"
                    : "settings.gitBackup.saveProvider",
              },
              { provider: name },
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void backup.testConnection()}
            disabled={busy}
            data-testid="git-backup-test"
          >
            <PlugZap className="size-4" />
            {intl.formatMessage(
              {
                id:
                  backup.operation === "test"
                    ? "settings.gitBackup.ossConfig.testing"
                    : "settings.gitBackup.testProvider",
              },
              { provider: name },
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={backup.resetDraft}
            disabled={busy || !backup.dirty}
          >
            <RotateCcw className="size-4" />
            {intl.formatMessage({ id: "settings.gitBackup.reset" })}
          </Button>
        </div>
        {backup.testResult ? (
          <p
            role={backup.testResult.ok ? "status" : "alert"}
            className={`break-words text-ui-caption ${backup.testResult.ok ? "text-success" : "text-destructive"}`}
          >
            {intl.formatMessage(
              {
                id: backup.testResult.ok
                  ? "settings.gitBackup.ossConfig.testSuccess"
                  : "settings.gitBackup.ossConfig.testFailed",
              },
              { error: backup.testResult.error ?? "" },
            )}
          </p>
        ) : null}
        {backup.dirty ? (
          <p className="text-ui-caption text-warning">
            {intl.formatMessage({ id: "settings.gitBackup.unsaved" })}
          </p>
        ) : null}
      </form>
      <section
        className="min-w-0 space-y-3 border-t border-border pt-4"
        data-testid={`git-backup-status-${provider}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-ui-base font-medium">
            {intl.formatMessage({ id: "settings.gitBackup.destinationStatus" }, { provider: name })}
          </h4>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void backup.backup(provider)}
            disabled={busy || !backup.canBackup}
            data-testid="git-backup-now"
          >
            <HardDriveUpload className="size-4" />
            {intl.formatMessage(
              {
                id:
                  backup.operation === "backup" || status?.running
                    ? "settings.gitBackup.manualBackup.running"
                    : "settings.gitBackup.manualBackup.provider",
              },
              { provider: name },
            )}
          </Button>
        </div>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.gitBackup.manualBackup.providerNote" },
            { provider: name },
          )}
        </p>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({
            id: configured
              ? "settings.gitBackup.status.destinationConfigured"
              : "settings.gitBackup.status.destinationNotConfigured",
          })}
        </p>
        {destination ? (
          <GitBackupResultDetails result={destination} />
        ) : (
          <p className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "settings.gitBackup.status.unknown" })}
          </p>
        )}
      </section>
    </div>
  );
}
