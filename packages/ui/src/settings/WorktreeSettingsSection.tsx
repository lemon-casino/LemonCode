import { WorktreeSettingsProject } from "./WorktreeSettingsProject.js";
import { useMemo } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useSidebarWorktrees } from "@/hooks/useSidebarWorktrees.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorktreeSettingsNavigation } from "@/store/worktreeSidebarStore.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { isWorktreeSidebarWorkspace } from "@/lib/worktreeSidebar.js";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select.js";

export function WorktreeSettingsSection({
  section,
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  isDesktop,
  onCreateTask,
  onBack,
  onSectionChange,
}: {
  section: "worktrees" | "environments";
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string;
  isDesktop?: boolean;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onBack?: () => void;
  onSectionChange: (section: "worktrees" | "environments") => void;
}) {
  const { intl } = useLCodeIntl();
  const trees = useSidebarWorktrees(workspaceTabs);
  const base = useBaseWorkspaceServices();
  const target = useWorktreeSettingsNavigation((state) => state.target);
  const select = useWorktreeSettingsNavigation((state) => state.select);
  const projects = useMemo(() => {
    const bindings = trees.entries.map((entry) => entry.binding);
    const scopes = new Map(
      workspaceTabs
        .filter(
          (tab) =>
            tab.workspacePurpose !== "conversation" && !isWorktreeSidebarWorkspace(tab, bindings),
        )
        .map((tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab]),
    );
    for (const { origin } of trees.entries)
      scopes.set(origin.workspaceIdentity?.trim() || origin.workspacePath, origin);
    return [...scopes.values()];
  }, [workspaceTabs, trees.entries]);
  const requestedKey = target
    ? target.workspaceIdentity?.trim() || target.workspacePath
    : activeWorkspaceIdentity?.trim() || activeWorkspacePath;
  const project =
    projects.find(
      (item) => (item.workspaceIdentity?.trim() || item.workspacePath) === requestedKey,
    ) ?? (target ? undefined : projects[0]);
  const key = project?.workspaceIdentity?.trim() || project?.workspacePath || "";
  const resolved = trees.lookup.get(key);
  const services = project ? resolved?.services : target ? undefined : base;
  const bindings = trees.entries
    .filter(
      (entry) => (entry.origin.workspaceIdentity?.trim() || entry.origin.workspacePath) === key,
    )
    .map((entry) => entry.binding);
  const selected =
    requestedKey === key
      ? bindings.find(
          (binding) => binding.id === target?.bindingId || binding.taskId === target?.sessionId,
        )
      : undefined;
  const text = (key: string) => intl.formatMessage({ id: `settings.worktrees.${key}` });
  return (
    <div className="min-w-0 space-y-4" data-testid={`settings-${section}-section`}>
      {projects.length ? (
        <div
          className="flex min-w-0 items-center gap-2 text-ui-sm"
          data-testid="coding-project-context"
        >
          <span className="shrink-0 text-foreground-subtle">{text("project")}</span>
          {projects.length === 1 ? (
            <span
              className="min-w-0 truncate font-medium"
              title={project?.workspacePath ?? target?.workspacePath}
            >
              {project?.label ?? target?.workspacePath}
            </span>
          ) : (
            <Select
              value={key}
              onValueChange={(value) => {
                const project = projects.find(
                  (item) => (item.workspaceIdentity?.trim() || item.workspacePath) === value,
                );
                if (project) select(project);
              }}
            >
              <SelectTrigger
                variant="ghost"
                size="sm"
                className="max-w-64 text-ui-sm"
                aria-label={text("project")}
                title={project?.workspacePath}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem
                    key={project.workspaceIdentity?.trim() || project.workspacePath}
                    value={project.workspaceIdentity?.trim() || project.workspacePath}
                  >
                    {project.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : null}
      {trees.errors.map((error) => (
        <p key={error} role="alert" className="break-words text-ui-sm text-destructive">
          {error === "remote-workspace-disconnected"
            ? intl.formatMessage({ id: "worktree.sidebarDisconnected" })
            : error}
        </p>
      ))}
      {services ? (
        <ServiceProvider services={services}>
          <WorktreeSettingsProject
            key={`${key}:${section}`}
            section={section}
            bindings={bindings}
            selected={selected}
            project={project}
            canSelectDirectory={Boolean(isDesktop && !resolved?.isRemoteWorkspace)}
            loading={trees.loading}
            refresh={trees.refresh}
            onSelect={(binding) => project && select({ ...project, bindingId: binding?.id })}
            onSectionChange={onSectionChange}
            onCreateTask={(request) => {
              onBack?.();
              onCreateTask?.(request);
            }}
          />
        </ServiceProvider>
      ) : (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "worktree.sidebarDisconnected" })}
        </p>
      )}
    </div>
  );
}
