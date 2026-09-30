import { HardDriveUpload, Loader2 } from "lucide-react";
import type { GitBackupWorkspaceTarget, IGitBackupService } from "@lcode/services";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useGitBackupRouting } from "@/hooks/useGitBackupRouting.js";
import { useGitBackupOnboarding } from "@/hooks/useGitBackupOnboarding.js";

interface GitBackupWelcomeDialogProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  allowLegacyMigration?: boolean;
  onOpenSettings: () => void;
}

export function GitBackupWelcomeDialog(props: GitBackupWelcomeDialogProps) {
  if (!props.workspacePath) return null;
  return <WorkspaceGitBackupWelcome {...props} workspacePath={props.workspacePath} />;
}

function WorkspaceGitBackupWelcome({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  allowLegacyMigration = false,
  onOpenSettings,
}: GitBackupWelcomeDialogProps & { workspacePath: string }) {
  const routing = useGitBackupRouting({
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  if (!routing.service || !routing.target) return null;
  return (
    <GitBackupWelcomeController
      key={routing.controllerKey}
      service={routing.service}
      workspace={routing.target}
      allowLegacyMigration={allowLegacyMigration && routing.connectionKind === "local-ready"}
      onOpenSettings={onOpenSettings}
    />
  );
}

function GitBackupWelcomeController({
  service,
  workspace,
  allowLegacyMigration,
  onOpenSettings,
}: {
  service: IGitBackupService;
  workspace: GitBackupWorkspaceTarget;
  allowLegacyMigration: boolean;
  onOpenSettings: () => void;
}) {
  const state = useGitBackupOnboarding(service, workspace, allowLegacyMigration, onOpenSettings);
  if (!state.open || state.loading) return null;
  return <GitBackupWelcomeView state={state} />;
}

export function GitBackupWelcomeView({
  state,
}: {
  state: ReturnType<typeof useGitBackupOnboarding>;
}) {
  const { intl } = useLCodeIntl();
  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open && !state.busy) void state.complete("skip");
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-ui-lg">
            <HardDriveUpload className="size-5 shrink-0" aria-hidden="true" />
            {intl.formatMessage({ id: "gitBackup.welcome.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "gitBackup.welcome.description" })}
          </DialogDescription>
        </DialogHeader>
        {state.error ? (
          <p role="alert" className="break-words text-ui-caption text-destructive">
            {intl.formatMessage(
              {
                id: state.ready ? "gitBackup.welcome.saveFailed" : "settings.gitBackup.loadFailed",
              },
              { error: state.error },
            )}
          </p>
        ) : null}
        <DialogFooter>
          {!state.ready ? (
            <Button variant="outline" disabled={state.busy} onClick={() => void state.reload()}>
              {intl.formatMessage({ id: "common.retry" })}
            </Button>
          ) : null}
          <Button variant="ghost" disabled={state.busy} onClick={() => void state.complete("skip")}>
            {intl.formatMessage({ id: "gitBackup.welcome.skipForNow" })}
          </Button>
          <Button
            disabled={state.busy || !state.ready}
            onClick={() => void state.complete("settings")}
          >
            {state.busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <HardDriveUpload className="size-4" aria-hidden="true" />
            )}
            {intl.formatMessage({ id: "gitBackup.welcome.enableNow" })}
          </Button>
        </DialogFooter>
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "gitBackup.welcome.skipNote" })}
        </p>
      </DialogContent>
    </Dialog>
  );
}
