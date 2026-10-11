import { useId } from "react";
import { gitBackupWorkspaceKey, type GitBackupWorkspaceTarget } from "@lcode/services";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

export function GitBackupWorkspaceSelector({
  workspaces,
  selected,
  target,
  busy,
  onSelect,
}: {
  workspaces: GitBackupWorkspaceTarget[];
  selected: GitBackupWorkspaceTarget[];
  target: GitBackupWorkspaceTarget | null;
  busy: boolean;
  onSelect: (workspace: GitBackupWorkspaceTarget, selected: boolean) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const id = useId();
  const selectedKeys = new Set(selected.map(gitBackupWorkspaceKey));
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border pt-4"
      aria-labelledby={`${id}-title`}
      data-testid="git-backup-workspaces"
    >
      <h3 id={`${id}-title`} className="text-ui-base font-medium">
        {intl.formatMessage({ id: "settings.gitBackup.workspaces" })}
      </h3>
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "settings.gitBackup.workspacesNote" })}
      </p>
      <p className="text-ui-caption text-foreground-subtle" aria-live="polite">
        {intl.formatMessage(
          { id: "settings.gitBackup.workspacesSelected" },
          { count: selected.length },
        )}
      </p>
      {workspaces.length ? (
        <ul className="divide-y divide-border">
          {workspaces.map((workspace, index) => {
            const key = gitBackupWorkspaceKey(workspace);
            const inputId = `${id}-${index}`;
            return (
              <li key={key} className="flex min-w-0 items-start gap-3 py-2">
                <Checkbox
                  id={inputId}
                  className="mt-1"
                  data-testid="git-backup-workspace-select"
                  checked={selectedKeys.has(key)}
                  disabled={busy}
                  onCheckedChange={(checked) => void onSelect(workspace, checked === true)}
                />
                <label
                  htmlFor={inputId}
                  className="min-w-0 flex-1 cursor-pointer space-y-1 text-ui-caption"
                >
                  <span className="block break-all font-mono">{workspace.workspacePath}</span>
                  {workspace.workspaceIdentity ? (
                    <span className="block break-all text-foreground-subtle">
                      {workspace.workspaceIdentity}
                    </span>
                  ) : null}
                  {target && gitBackupWorkspaceKey(target) === key ? (
                    <span className="block text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.gitBackup.currentWorkspace" })}
                    </span>
                  ) : null}
                </label>
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
