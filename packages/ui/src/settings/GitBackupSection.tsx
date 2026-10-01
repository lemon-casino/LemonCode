import { useId } from "react";
import { Download, HardDriveUpload, KeyRound, Loader2, RotateCcw } from "lucide-react";
import type { GitBackupWorkspaceTarget } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useGitBackup } from "@/hooks/useGitBackup.js";
import { useGitBackupRouting, type GitBackupSectionTarget } from "@/hooks/useGitBackupRouting.js";
import { GitBackupDestinationTabs } from "@/settings/git-backup/GitBackupDestinationTabs.js";
import { GitBackupStatusPanel } from "@/settings/git-backup/GitBackupStatusPanel.js";

export function GitBackupSection(props: GitBackupSectionTarget) {
  const route = useGitBackupRouting(props);
  return <GitBackupSectionController key={route.controllerKey} {...route} />;
}

export function GitBackupSectionController(props: Parameters<typeof useGitBackup>[0]) {
  const backup = useGitBackup(props);
  return (
    <GitBackupSettingsView
      backup={backup}
      target={props.target}
      connectionKind={props.connectionKind}
    />
  );
}

export function GitBackupSettingsView({
  backup,
  target,
  connectionKind,
}: {
  backup: ReturnType<typeof useGitBackup>;
  target: GitBackupWorkspaceTarget | null;
  connectionKind: "local-ready" | "remote-ready" | "remote-waiting";
}) {
  const { intl } = useLCodeIntl();
  const intervalId = useId();
  const enabledId = useId();
  const destinationFormId = useId();
  const busy = Boolean(backup.operation);
  const { config, draft } = backup;
  const failure = backup.error
    ? intl.formatMessage({ id: backup.error.id }, { error: backup.error.detail ?? "" })
    : null;
  return (
    <div className="min-w-0 space-y-5" data-testid="git-backup-settings">
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "settings.gitBackup.description" })}
      </p>
      {backup.unavailable ? (
        <p role="status" className="break-words text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id:
              connectionKind === "remote-waiting"
                ? "settings.gitBackup.disconnected"
                : "settings.gitBackup.unavailable",
          })}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="break-words text-ui-caption text-destructive">
          {failure}
        </p>
      ) : null}
      {backup.notice ? (
        <p
          role="status"
          className={`break-words text-ui-caption ${backup.notice.id === "settings.gitBackup.migrationCleanupFailed" ? "text-warning" : "text-foreground-subtle"}`}
        >
          {intl.formatMessage(
            { id: backup.notice.id },
            { error: backup.notice.detail ?? "", count: Number(backup.notice.detail ?? 0) },
          )}
        </p>
      ) : null}
      {backup.loading ? (
        <p role="status" className="flex items-center gap-2 text-ui-caption text-foreground-subtle">
          <Loader2 className="size-4 animate-spin" />
          {intl.formatMessage({ id: "settings.gitBackup.loading" })}
        </p>
      ) : null}
      {!backup.unavailable && !backup.loading && !config ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void backup.refresh()}>
          <RotateCcw className="size-4" />
          {intl.formatMessage({ id: "settings.gitBackup.retry" })}
        </Button>
      ) : null}
      {config && draft ? (
        <>
          <section
            className="space-y-3 border-t border-border pt-4"
            data-testid="git-backup-shared"
          >
            <h3 className="text-ui-base font-medium">
              {intl.formatMessage({ id: "settings.gitBackup.shared" })}
            </h3>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={enabledId} className="text-ui-base font-medium">
                  {intl.formatMessage({ id: "settings.gitBackup.enabled" })}
                </label>
                <p className="mt-1 text-ui-caption text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.gitBackup.switchNote" })}
                </p>
              </div>
              <Switch
                id={enabledId}
                data-testid="git-backup-enabled"
                checked={config.enabled}
                disabled={busy || (!config.enabled && !backup.canEnable)}
                onCheckedChange={(enabled) => void backup.setEnabled(enabled)}
                aria-label={intl.formatMessage({ id: "settings.gitBackup.enabled" })}
              />
            </div>
            <p className="break-all text-ui-caption text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.gitBackup.currentWorkspacePath" },
                {
                  path:
                    target?.workspacePath ??
                    intl.formatMessage({ id: "settings.gitBackup.noWorkspace" }),
                },
              )}
            </p>
            {target?.workspaceIdentity ? (
              <p className="break-all text-ui-caption text-foreground-subtle">
                {target.workspaceIdentity}
              </p>
            ) : null}
            <div className="space-y-1">
              <label htmlFor={intervalId} className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.interval" })}
              </label>
              <Input
                id={intervalId}
                form={destinationFormId}
                type="number"
                min={5}
                max={1440}
                step={1}
                value={draft.intervalMinutes}
                disabled={busy && backup.operation !== "test"}
                onChange={(event) =>
                  backup.updateDraft({ ...draft, intervalMinutes: event.target.value })
                }
                aria-describedby={`${intervalId}-note`}
                className="w-32 text-mobile-input-safe sm:text-ui-base"
                data-testid="git-backup-interval"
              />
              <p id={`${intervalId}-note`} className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.interval.note" })}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage({ id: "settings.gitBackup.manualBackup.savedConfig" })}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void backup.backup("all")}
                disabled={busy || !backup.canBackupAll}
                data-testid="git-backup-now-all"
              >
                <HardDriveUpload className="size-4" />
                {intl.formatMessage({ id: "settings.gitBackup.manualBackup.all" })}
              </Button>
            </div>
          </section>
          <GitBackupDestinationTabs backup={backup} target={target} formId={destinationFormId} />
          <GitBackupStatusPanel
            status={backup.status}
            workspaces={config.workspaces}
            target={target}
            busy={busy}
            refresh={backup.refresh}
            remove={backup.removeWorkspace}
          />
          <section className="space-y-3 border-t border-border pt-4">
            <h3 className="text-ui-base font-medium">
              {intl.formatMessage({ id: "settings.gitBackup.encryption" })}
            </h3>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void backup.viewPublicKey()}
                data-testid="git-backup-public-key"
              >
                <KeyRound className="size-4" />
                {intl.formatMessage({ id: "settings.gitBackup.encryption.publicKey" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !backup.canExport}
                onClick={() => void backup.exportPrivateKey()}
                data-testid="git-backup-export-key"
              >
                <Download className="size-4" />
                {intl.formatMessage({ id: "settings.gitBackup.encryption.exportPrivateKey" })}
              </Button>
            </div>
            <p className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: "settings.gitBackup.encryption.exportWarning" })}
            </p>
          </section>
        </>
      ) : null}
      <Dialog
        open={backup.publicKey !== null}
        onOpenChange={(open) => {
          if (!open) backup.closePublicKey();
        }}
      >
        <DialogContent className="sm:max-w-xl" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "settings.gitBackup.encryption.publicKey" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.gitBackup.encryption.publicKeyDescription" })}
            </DialogDescription>
          </DialogHeader>
          <pre
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-caption"
            data-testid="git-backup-public-key-value"
          >
            {backup.publicKey}
          </pre>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">
                {intl.formatMessage({ id: "settings.gitBackup.close" })}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
