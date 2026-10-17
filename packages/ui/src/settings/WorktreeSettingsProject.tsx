import { useState } from "react";
import { WorktreeTaskActions } from "@/worktree/WorktreeTaskActions.js";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import type { WorktreeBinding } from "@lcode/services";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorktreeManagement } from "@/hooks/useWorktreeManagement.js";
import { useWorktreeDeletionProjection } from "@/hooks/useWorktreeDeletionProjection.js";
import { useProjectExecutionPolicy } from "@/hooks/useProjectExecutionPolicy.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select.js";
import { WorktreeManagementActions } from "@/worktree/WorktreeManagementActions.js";
import { RuntimeEnvironmentDetails } from "@/worktree/RuntimeEnvironmentDetails.js";
import { SettingsRow } from "./SettingsPageParts.js";
import { WorktreeGeneralSettings } from "./WorktreeGeneralSettings.js";

export function WorktreeSettingsProject({
  section,
  bindings,
  selected,
  project,
  canSelectDirectory,
  loading,
  refresh,
  onSelect,
  onSectionChange,
  onCreateTask,
}: {
  section: "worktrees" | "environments";
  bindings: WorktreeBinding[];
  selected?: WorktreeBinding;
  project?: WorkspaceTabState;
  canSelectDirectory: boolean;
  loading: boolean;
  refresh(): Promise<void>;
  onSelect(binding?: WorktreeBinding): void;
  onSectionChange(section: "worktrees" | "environments"): void;
  onCreateTask(request: CreateTaskRequest): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.worktrees.${key}` });
  const management = useWorktreeManagement(
    project?.workspacePath ?? "",
    project?.workspaceIdentity,
  );
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const { handleSelectTask } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath: project?.workspacePath ?? "",
    workspaceIdentity: project?.workspaceIdentity,
    activateTabByPath,
    onNavigateToTask: () => {
      // 设置页可从另一项目打开审核；退出旧分屏选择，避免审核请求被不可见会话消费。
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
    },
  });
  const deleted = useWorktreeDeletionProjection();
  const [search, setSearch] = useState("");
  const filtered = bindings.filter((binding) =>
    `${binding.displayName ?? ""} ${binding.branch} ${binding.checkoutPath}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  const openEnvironment = () => onSectionChange("environments");
  return (
    <div className="min-w-0 space-y-6">
      {!selected && section === "worktrees" && management.settings ? (
        <WorktreeGeneralSettings
          key={JSON.stringify(management.settings)}
          settings={management.settings}
          pending={management.pending}
          save={management.save}
          canSelectDirectory={canSelectDirectory}
        />
      ) : null}
      {!selected && section === "environments" && project ? (
        <EnvironmentPolicySettings project={project} />
      ) : null}
      {management.error ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {management.error}
        </p>
      ) : null}
      {management.cleanupResult ? (
        <div role="status" className="space-y-1 text-ui-sm">
          <p>
            {intl.formatMessage(
              { id: "settings.worktrees.cleanupResult" },
              {
                archived: management.cleanupResult.archivedIds.length,
                skipped: management.cleanupResult.skipped.length,
              },
            )}
          </p>
          {management.cleanupResult.skipped.map((item) => (
            <p className="break-words text-foreground-subtle" key={item.bindingId}>
              {bindings.find((binding) => binding.id === item.bindingId)?.displayName ??
                bindings.find((binding) => binding.id === item.bindingId)?.branch ??
                item.bindingId}
              : {item.reason}
            </p>
          ))}
        </div>
      ) : null}
      <section className="min-w-0 space-y-3" aria-label={text("list")}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3
            className="min-w-0 flex-1 truncate text-ui-lg font-medium"
            title={selected?.displayName ?? selected?.branch}
          >
            {selected
              ? (selected.displayName ?? selected.branch)
              : text(section === "worktrees" ? "list" : "linkedEnvironments")}
          </h3>
          {!selected && section === "worktrees" ? (
            <>
              <Button
                variant="outline"
                disabled={!project}
                onClick={() =>
                  project &&
                  onCreateTask({
                    targetWorkspace: project,
                    newWorktree: true,
                    createSource: "project",
                  })
                }
              >
                <Plus className="size-3.5" />
                {text("create")}
              </Button>
              <Button
                variant="ghost"
                disabled={management.pending || !management.settings?.autoDeleteEnabled}
                onClick={() => void management.cleanup().then(() => refresh())}
              >
                {text("cleanup")}
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            aria-label={intl.formatMessage({ id: "worktree.refresh" })}
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
        {selected && project ? (
          <div className="min-w-0 space-y-3" data-testid="worktree-settings-details">
            <Button variant="ghost" onClick={() => onSelect()}>
              <ArrowLeft className="size-3.5" />
              {text("backToList")}
            </Button>
            {section === "worktrees" ? (
              <>
                {selected.ownerRef?.kind === "executionSet" ? <WorktreeTaskActions workspacePath={selected.originalWorkspacePath} workspaceIdentity={selected.originalWorkspaceIdentity} workspaceRemoteSessionId={project.remoteSessionId} bindingId={selected.id} busy={false} /> : null}
                <WorktreeManagementActions
                  workspacePath={project.workspacePath}
                  workspaceIdentity={project.workspaceIdentity}
                  workspaceRemoteSessionId={project.remoteSessionId}
                  sessionId={selected.taskId}
                  bindingId={selected.id}
                  busy={false}
                  renderContent={(content) => content}
                  showEnvironment={false}
                  nameEditor={
                    <WorktreeNameEditor
                      key={selected.id}
                      binding={selected}
                      pending={management.pending}
                      onSave={management.rename}
                    />
                  }
                  environmentAction={
                    <Button size="sm" variant="ghost" onClick={openEnvironment}>
                      {intl.formatMessage({ id: "settings.environments.title" })}
                    </Button>
                  }
                  onSelectSession={(sessionId) =>
                    handleSelectTask(project.workspacePath, sessionId, project.workspaceIdentity)
                  }
                  onWorktreeDeleted={(binding) => {
                    deleted(binding);
                    onSelect();
                    void refresh();
                  }}
                />
              </>
            ) : (
              <RuntimeEnvironmentDetails
                binding={selected}
                workspacePath={project.workspacePath}
                workspaceIdentity={project.workspaceIdentity}
                workspaceRemoteSessionId={project.remoteSessionId}
                onSettled={() => void refresh()}
              />
            )}
          </div>
        ) : (
          <>
            <Input
              aria-label={text("search")}
              placeholder={text("search")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {loading ? (
              <p role="status" className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.loading" })}
              </p>
            ) : null}
            <ul className="divide-y divide-border" data-testid="worktree-settings-list">
              {filtered.map((binding) => (
                <li key={binding.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md px-2 py-3 text-left hover:bg-surface-hover"
                    onClick={() => onSelect(binding)}
                  >
                    <span className="min-w-0 flex-1 basis-40">
                      <span className="block truncate text-ui-base" title={binding.branch}>
                        {binding.displayName ?? binding.branch}
                      </span>
                      <span
                        className="block truncate text-ui-sm text-foreground-subtle"
                        title={binding.checkoutPath}
                      >
                        {binding.checkoutPath}
                      </span>
                    </span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {section === "environments"
                        ? intl.formatMessage({
                            id: `runtimeEnvironment.policy.${binding.environmentRef ? "managed" : "local"}`,
                          })
                        : intl.formatMessage({ id: `worktree.binding.${binding.status}` })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {!loading && !filtered.length ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "worktree.noWorktrees" })}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function WorktreeNameEditor({
  binding,
  pending,
  onSave,
}: {
  binding: WorktreeBinding;
  pending: boolean;
  onSave(id: string, name: string): Promise<boolean>;
}) {
  const { intl } = useLCodeIntl();
  const [name, setName] = useState(binding.displayName ?? binding.branch);
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <Input
        className="min-w-0 flex-1 basis-28"
        aria-label={intl.formatMessage({ id: "settings.worktrees.name" })}
        value={name}
        maxLength={120}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        variant="outline"
        disabled={
          pending || !name.trim() || name.trim() === (binding.displayName ?? binding.branch)
        }
        onClick={() => void onSave(binding.id, name.trim())}
      >
        {intl.formatMessage({ id: "common.save" })}
      </Button>
    </div>
  );
}

function EnvironmentPolicySettings({ project }: { project: WorkspaceTabState }) {
  const { intl } = useLCodeIntl();
  const { policy, loading, update } = useProjectExecutionPolicy(
    project.workspacePath,
    project.workspaceIdentity,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section className="space-y-3" data-testid="environment-policy-settings">
      <div className="rounded-xl border border-border">
        <SettingsRow
          label={intl.formatMessage({ id: "runtimeEnvironment.policy" })}
          description={intl.formatMessage({ id: "runtimeEnvironment.policyHint" })}
          controlLayout="wide"
          control={
            <Select
              value={policy.environmentPreference}
              disabled={loading || pending}
              onValueChange={(value) => {
                setPending(true);
                setError(undefined);
                void update({
                  projectExecutionPreferences: {
                    [project.workspaceIdentity?.trim() || project.workspacePath]: {
                      environmentPolicy: value as "inherit" | "managed" | "local",
                    },
                  },
                })
                  .catch((reason) => setError(String(reason)))
                  .finally(() => setPending(false));
              }}
            >
              <SelectTrigger
                className="w-full"
                aria-label={intl.formatMessage({ id: "runtimeEnvironment.policy" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["inherit", "local", "managed"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {intl.formatMessage({ id: `runtimeEnvironment.policy.${value}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </div>
      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
