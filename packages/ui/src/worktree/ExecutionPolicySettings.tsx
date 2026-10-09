import {
  gitCommitReviewModeSchema,
  resolveGlobalGitCommitReviewMode,
  resolveProjectExecutionPolicy,
  TID_SETTINGS_GIT_COMMIT_REVIEW_MODE_SELECT,
} from "@lcode/shared";
import { useState } from "react";
import type { AppSettings, GitCommitReviewMode } from "@lcode/shared";
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
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";

export function GlobalExecutionPolicySettings() {
  const { settings, update, loading } = useSettings();
  const { intl } = useLCodeIntl();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Partial<AppSettings>) => {
    setPending(true);
    setError(null);
    try {
      await runUserActionAsync({
        input: {
          featureId: "settings.conversation",
          action: patch.gitCommitReviewMode
            ? "change_git_commit_review_mode"
            : "change_execution_mode",
          trigger: "select",
        },
        operation: () => update(patch),
        completed: {
          resultSource: "shared_settings",
        },
        failureStage: "settings_commit",
      });
    } catch (reason) {
      setError(getErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <SettingsRow
        controlLayout="wide"
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
            <SelectTrigger size="lg" className="w-full" data-testid="global-execution-mode">
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
        label={intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
        description={intl.formatMessage({ id: "settings.gitCommitReviewModeDescription" })}
        controlLayout="wide"
        control={
          <Select
            value={resolveGlobalGitCommitReviewMode(settings ?? {})}
            disabled={loading || pending}
            onValueChange={(value) => {
              void save({ gitCommitReviewMode: value as GitCommitReviewMode });
            }}
          >
            <SelectTrigger
              size="lg"
              className="w-full"
              data-testid={TID_SETTINGS_GIT_COMMIT_REVIEW_MODE_SELECT}
              aria-label={intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {gitCommitReviewModeSchema.options.map((mode) => (
                <SelectItem value={mode} key={mode}>
                  {intl.formatMessage({ id: `settings.gitCommitReviewMode.${mode}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
  const effectivePolicy = resolveProjectExecutionPolicy(settings ?? {}, {
    workspacePath,
    workspaceIdentity,
  });
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
  return (
    <div className="min-w-0 space-y-3" data-testid="project-execution-policy">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "worktree.projectSettingsDescription" })}
      </p>
      <label className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-ui-sm">
        <span className="min-w-0 space-y-1">
          <span className="block">
            {intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
          </span>
          {!loading ? (
            <span
              className="block text-foreground-subtle"
              data-testid="project-policy-effective-gitCommitReviewMode"
            >
              {intl.formatMessage(
                { id: "worktree.effectiveSetting" },
                {
                  value: intl.formatMessage({
                    id: `settings.gitCommitReviewMode.${effectivePolicy.gitCommitReviewMode}`,
                  }),
                },
              )}
            </span>
          ) : null}
        </span>
        <Select
          value={effectivePolicy.gitCommitReviewPreference}
          disabled={loading || pending}
          onValueChange={(value) => {
            void save({ gitCommitReviewMode: value as Preferences["gitCommitReviewMode"] });
          }}
        >
          <SelectTrigger
            className="w-full sm:w-64"
            data-testid="project-policy-gitCommitReviewMode"
            aria-label={intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["inherit", ...gitCommitReviewModeSchema.options].map((value) => (
              <SelectItem key={value} value={value}>
                {intl.formatMessage({
                  id:
                    value === "inherit"
                      ? "worktree.mode.inherit"
                      : `settings.gitCommitReviewMode.${value}`,
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-ui-sm">
        <span className="min-w-0 space-y-1">
          <span className="block">{intl.formatMessage({ id: "runtimeEnvironment.policy" })}</span>
          <span
            className="block text-foreground-subtle"
            data-testid="project-policy-effective-environmentPolicy"
          >
            {intl.formatMessage(
              { id: "worktree.effectiveSetting" },
              {
                value: intl.formatMessage({
                  id: `runtimeEnvironment.policy.${effectivePolicy.environmentPolicy}`,
                }),
              },
            )}
          </span>
        </span>
        <Select
          value={effectivePolicy.environmentPreference}
          disabled={loading || pending}
          onValueChange={(value) =>
            void save({ environmentPolicy: value as Preferences["environmentPolicy"] })
          }
        >
          <SelectTrigger
            className="w-full sm:w-64"
            data-testid="project-policy-environmentPolicy"
            aria-label={intl.formatMessage({ id: "runtimeEnvironment.policy" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["inherit", "managed", "local"] as const).map((value) => (
              <SelectItem key={value} value={value}>
                {intl.formatMessage({ id: `runtimeEnvironment.policy.${value}` })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "runtimeEnvironment.policyHint" })}
      </p>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
