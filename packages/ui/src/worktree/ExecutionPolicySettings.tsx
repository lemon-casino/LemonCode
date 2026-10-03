import { useState } from "react";
import type { AppSettings } from "@lcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { ProjectWorktreeAdvancedSettings } from "./ProjectWorktreeAdvancedSettings.js";
import { ProjectWorktreeList } from "./ProjectWorktreeList.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export function GlobalExecutionPolicySettings() {
  const { settings, update, loading } = useSettings();
  const { intl } = useLCodeIntl();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<AppSettings>) => {
    setPending(true);
    setError(null);
    try {
      await update(patch);
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "worktree.defaultMode" })}
        description={intl.formatMessage({ id: "worktree.defaultModeDescription" })}
        control={
          <Select
            value={settings?.defaultSessionExecutionMode ?? "local"}
            disabled={loading || pending}
            onValueChange={(mode) => {
              void save({ defaultSessionExecutionMode: mode as "local" | "worktree" });
            }}
          >
            <SelectTrigger className="w-52" data-testid="global-execution-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["local", "worktree"] as const).map((mode) => (
                <SelectItem value={mode} key={mode}>
                  {intl.formatMessage({ id: `worktree.mode.${mode}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "worktree.autoOpenReview" })}
        description={intl.formatMessage({ id: "worktree.autoOpenReviewDescription" })}
        control={
          <Switch
            data-testid="global-auto-open-review"
            aria-label={intl.formatMessage({ id: "worktree.autoOpenReview" })}
            disabled={loading || pending}
            checked={settings?.autoOpenGitCommitReview !== false}
            onCheckedChange={(value) => {
              void save({ autoOpenGitCommitReview: value });
            }}
          />
        }
      />
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function ProjectExecutionPolicySettings({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { settings, update, loading } = useSettings();
  const { intl } = useLCodeIntl();
  const scope = workspaceIdentity?.trim() || workspacePath;
  const preferences = settings?.projectExecutionPreferences?.[scope];
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  type Preferences = NonNullable<AppSettings["projectExecutionPreferences"]>[string];
  const save = async (patch: Partial<Preferences>) => {
    setPending(true);
    setError(null);
    try {
      await update({ projectExecutionPreferences: { [scope]: patch } });
      return true;
    } catch (reason) {
      setError(getErrorMessage(reason));
      return false;
    } finally {
      setPending(false);
    }
  };
  const rows = [
    {
      field: "executionMode",
      label: "worktree.projectMode",
      options: ["inherit", "local", "worktree"],
    },
    {
      field: "autoGenerateGitCommitMessage",
      label: "settings.autoGenerateGitCommitMessage",
      options: ["inherit", "enabled", "disabled"],
    },
    {
      field: "autoOpenGitCommitReview",
      label: "worktree.autoOpenReview",
      options: ["inherit", "enabled", "disabled"],
    },
  ] as const;
  return (
    <div className="min-w-0 space-y-3" data-testid="project-execution-policy">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.projectSettingsDescription" })}
      </p>
      {rows.map((row) => (
        <label
          key={row.field}
          className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-ui-sm"
        >
          <span>{intl.formatMessage({ id: row.label })}</span>
          <Select
            value={preferences?.[row.field] ?? "inherit"}
            disabled={loading || pending}
            onValueChange={(value) => {
              void save({ [row.field]: value });
            }}
          >
            <SelectTrigger className="w-40" data-testid={`project-policy-${row.field}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {row.options.map((value) => (
                <SelectItem key={value} value={value}>
                  {intl.formatMessage({ id: `worktree.mode.${value}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ))}
      <ProjectWorktreeAdvancedSettings
        key={scope}
        preferences={preferences}
        pending={loading || pending}
        save={save}
      />
      <ProjectWorktreeList workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} />
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
