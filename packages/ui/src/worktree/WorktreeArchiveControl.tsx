import { ArchiveIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function WorktreeArchiveControl({
  disabled,
  acknowledged,
  onChange,
  onArchive,
}: {
  disabled: boolean;
  acknowledged: boolean;
  onChange: (value: boolean) => void;
  onArchive: () => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.archiveDescription" })}
      </p>
      <label className="flex items-start gap-2 text-ui-sm">
        <Checkbox
          disabled={disabled}
          checked={acknowledged}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <span>{intl.formatMessage({ id: "worktree.archiveIgnored" })}</span>
      </label>
      <Button type="button" variant="outline" disabled={disabled} onClick={onArchive}>
        <ArchiveIcon className="size-4" />
        {intl.formatMessage({ id: "worktree.archive" })}
      </Button>
    </div>
  );
}
