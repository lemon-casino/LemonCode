import { useState } from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  useSessionConfigurationProjects,
  sessionConfigurationProjectKey as projectKey,
  type SessionConfigurationProject as Project,
} from "@/hooks/useSessionConfigurationProjects.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import { SessionConfigurationForm } from "./SessionConfigurationForm.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

const DEFAULT_SCOPE = "default";
function ProjectConfiguration({ project }: { project: Project }) {
  const { intl } = useLCodeIntl();
  const target = useWorkspaceServicesResolution(
    project.workspacePath,
    project.remoteSessionId,
    project.workspaceIdentity,
    project.remoteTarget,
  );
  const [owner, setOwner] = useState({ services: target.services, revision: 0 });
  // 原因：同 identity/sessionId 的 accessor 换代后旧保存仍在 pending，曾锁住新连接表单。
  // 表单状态属于当前服务实例；同步换 key，迟到完成/错误留在已卸载的旧实例。
  if (owner.services !== target.services)
    setOwner({ services: target.services, revision: owner.revision + 1 });
  if (!target.rpcReady)
    return (
      <p role="status" className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.configuration.remoteDisconnected" })}
      </p>
    );
  return (
    <ServiceProvider services={target.services}>
      <SessionConfigurationForm key={owner.revision} project={project} />
    </ServiceProvider>
  );
}

export function SessionConfigurationSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string;
}) {
  const { intl } = useLCodeIntl();
  const projects = useSessionConfigurationProjects(workspaceTabs);
  const [selection, setSelection] = useState<{ key: string; project?: Project }>(() => ({
    key: activeWorkspacePath
      ? projectKey({
          workspacePath: activeWorkspacePath,
          workspaceIdentity: activeWorkspaceIdentity,
          label: "",
        })
      : DEFAULT_SCOPE,
  }));
  const fromSources = projects.find((project) => projectKey(project) === selection.key);
  // 原因：仅在 live 注册表中的项目断线后会消失，旧逻辑悄悄切到全局配置，易误改默认值。
  // 只保留当前选择的元数据；在线状态和 accessor 仍完全由注册表解析。
  const remembered = selection.project;
  const selected =
    fromSources ??
    (remembered?.workspaceIdentity || remembered?.remoteTarget || remembered?.remoteSessionId
      ? remembered
      : undefined);
  if (fromSources && fromSources !== remembered)
    setSelection({ key: selection.key, project: fromSources });
  const options = selected && !fromSources ? [...projects, selected] : projects;
  const value = selected ? selection.key : DEFAULT_SCOPE;
  return (
    <div className="min-w-0 space-y-4" data-testid="settings-configuration-section">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.worktrees.project" })}
        </span>
        <Select
          value={value}
          onValueChange={(key) =>
            setSelection({ key, project: projects.find((project) => projectKey(project) === key) })
          }
        >
          <SelectTrigger
            className="w-full sm:w-auto sm:max-w-80"
            aria-label={intl.formatMessage({ id: "settings.worktrees.project" })}
            data-testid="configuration-project"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SCOPE}>
              {intl.formatMessage({ id: "settings.configuration.default" })}
            </SelectItem>
            {options.map((project) => (
              <SelectItem key={projectKey(project)} value={projectKey(project)}>
                {project.label}
                {project.remoteTarget
                  ? ` · ${formatRemoteWorkspaceTargetSubtitle(project.remoteTarget)}`
                  : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selected ? (
        <ProjectConfiguration key={selection.key} project={selected} />
      ) : (
        <SessionConfigurationForm key={DEFAULT_SCOPE} />
      )}
    </div>
  );
}
