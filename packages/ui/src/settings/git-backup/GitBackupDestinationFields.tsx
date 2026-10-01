import { useId } from "react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog.js";
import { hasStoredGitBackupSecret } from "@/hooks/useGitBackupDraft.js";
import type { useGitBackup } from "@/hooks/useGitBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBackupOssFields } from "./GitBackupOssFields.js";

export function GitBackupDestinationFields({
  backup,
  busy,
}: {
  backup: ReturnType<typeof useGitBackup>;
  busy: boolean;
}) {
  const { intl } = useLCodeIntl();
  const id = useId();
  const { config, draft, provider } = backup;
  if (!config || !draft) return null;
  const providerName = intl.formatMessage({ id: `settings.gitBackup.provider.${provider}` });
  const editable = !busy || backup.operation === "test";
  return (
    <>
      {provider === "oss" ? (
        <>
          {backup.legacyDraft ? (
            <p className="text-ui-caption text-warning">
              {intl.formatMessage({ id: "gitBackup.welcome.legacyConfig" })}
            </p>
          ) : null}
          <GitBackupOssFields
            oss={draft.oss}
            disabled={!editable}
            secretStored={hasStoredGitBackupSecret(draft.oss, config.oss)}
            onChange={(field, value) =>
              backup.updateDraft({ ...draft, oss: { ...draft.oss, [field]: value } })
            }
          />
        </>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
          {(
            [
              "endpoint",
              "accessKeyId",
              "accessKeySecret",
              "bucket",
              "region",
              "pathPrefix",
            ] as const
          ).map((field) => (
            <div
              key={field}
              className={`min-w-0 space-y-1 ${field === "endpoint" || field === "pathPrefix" ? "sm:col-span-2" : ""}`}
            >
              <label
                htmlFor={`${id}-minio-${field}`}
                className="text-ui-caption text-foreground-subtle"
              >
                {intl.formatMessage({
                  id:
                    field === "endpoint"
                      ? "settings.gitBackup.minio.endpoint"
                      : `settings.gitBackup.ossConfig.${field}`,
                })}
              </label>
              <Input
                id={`${id}-minio-${field}`}
                data-testid={`git-backup-minio-${field}`}
                name={`minio-${field}`}
                type={field === "accessKeySecret" ? "password" : "text"}
                value={draft.minio[field] ?? ""}
                disabled={!editable}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  field === "endpoint"
                    ? "https://storage.example:9000"
                    : field === "region"
                      ? "us-east-1"
                      : field === "accessKeySecret" &&
                          hasStoredGitBackupSecret(draft.minio, config.minio ?? null)
                        ? intl.formatMessage({ id: "settings.gitBackup.ossConfig.secretStored" })
                        : undefined
                }
                onChange={(event) =>
                  backup.updateDraft({
                    ...draft,
                    minio: { ...draft.minio, [field]: event.target.value },
                  })
                }
                className="min-w-0 text-mobile-input-safe sm:text-ui-base"
              />
              {field === "endpoint" ? (
                <>
                  <p className="text-ui-caption text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.gitBackup.minio.endpointNote" })}
                  </p>
                  {/^http:\/\//i.test(draft.minio.endpoint.trim()) ? (
                    <p role="status" className="text-ui-caption text-warning">
                      {intl.formatMessage({ id: "settings.gitBackup.minio.httpWarning" })}
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !config[provider]}
            data-testid="git-backup-clear"
          >
            {intl.formatMessage({ id: "settings.gitBackup.clear" })}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage(
                { id: "settings.gitBackup.clearTitle" },
                { provider: providerName },
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.gitBackup.clearDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {intl.formatMessage({ id: "settings.gitBackup.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => void backup.clearDestination()}
              data-testid="git-backup-clear-confirm"
            >
              {intl.formatMessage({ id: "settings.gitBackup.clear" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
