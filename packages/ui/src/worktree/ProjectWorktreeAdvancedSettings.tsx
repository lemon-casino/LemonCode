import { useState } from "react";
import type { ProjectExecutionPreference } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";

const fields = ["setupCommands", "copyIgnoredPaths", "validationCommands"] as const;
export function ProjectWorktreeAdvancedSettings({
  preferences,
  pending,
  save,
}: {
  preferences?: ProjectExecutionPreference;
  pending: boolean;
  save: (patch: Partial<ProjectExecutionPreference>) => Promise<boolean>;
}) {
  const { intl } = useLCodeIntl();
  const [draft, setDraft] = useState<Partial<Record<(typeof fields)[number], string>>>({});
  return (
    <details className="border-t border-border pt-2 text-ui-sm">
      <summary className="cursor-pointer">
        {intl.formatMessage({ id: "worktree.advanced" })}
      </summary>
      <p className="my-2 text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.advancedDescription" })}
      </p>
      <div className="space-y-3">
        {fields.map((field) => (
          <label key={field} className="block space-y-1">
            <span>{intl.formatMessage({ id: `worktree.${field}` })}</span>
            <Textarea
              data-testid={`project-policy-${field}`}
              className="font-mono text-mobile-input-safe sm:text-ui-sm"
              disabled={pending}
              value={draft[field] ?? preferences?.[field]?.join("\n") ?? ""}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, [field]: event.target.value }))
              }
            />
          </label>
        ))}
        <Button
          type="button"
          disabled={pending || Object.keys(draft).length === 0}
          onClick={() => {
            const patch = Object.fromEntries(
              Object.entries(draft).map(([key, value]) => [
                key,
                value
                  .split(/\r?\n/u)
                  .map((line) => line.trim())
                  .filter(Boolean),
              ]),
            );
            void save(patch).then((saved) => {
              if (saved) setDraft({});
            });
          }}
        >
          {intl.formatMessage({ id: "worktree.saveAdvanced" })}
        </Button>
      </div>
    </details>
  );
}
