import { useId } from "react";
import type { GitBackupOssConfig } from "@lcode/services";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitBackupOssFields({
  oss,
  onChange,
  disabled = false,
  secretStored = false,
  idPrefix,
}: {
  oss: GitBackupOssConfig;
  onChange: (field: keyof GitBackupOssConfig, value: string) => void;
  disabled?: boolean;
  secretStored?: boolean;
  idPrefix?: string;
}) {
  const { intl } = useLCodeIntl();
  const generatedId = useId();
  const prefix = idPrefix ?? generatedId;
  const fields = ["accessKeyId", "accessKeySecret", "bucket", "region", "pathPrefix"] as const;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const id = `${prefix}-${field}`;
        const placeholder =
          field === "accessKeySecret" && secretStored
            ? intl.formatMessage({ id: "settings.gitBackup.ossConfig.secretStored" })
            : field === "region"
              ? intl.formatMessage({ id: "settings.gitBackup.ossConfig.regionPlaceholder" })
              : field === "pathPrefix"
                ? "lcode-backups"
                : undefined;
        return (
          <div
            key={field}
            className={
              field === "pathPrefix" ? "min-w-0 space-y-1 sm:col-span-2" : "min-w-0 space-y-1"
            }
          >
            <label htmlFor={id} className="text-ui-caption text-foreground-subtle">
              {intl.formatMessage({ id: `settings.gitBackup.ossConfig.${field}` })}
            </label>
            <Input
              id={id}
              name={field}
              data-testid={`git-backup-${field}`}
              type={field === "accessKeySecret" ? "password" : "text"}
              value={oss[field] ?? ""}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              onChange={(event) => onChange(field, event.target.value)}
              className="min-w-0 text-mobile-input-safe sm:text-ui-base"
            />
          </div>
        );
      })}
    </div>
  );
}
