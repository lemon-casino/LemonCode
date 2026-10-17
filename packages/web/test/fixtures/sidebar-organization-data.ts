import { buildRemoteWorkspaceIdentity, type LCodeTaskMeta } from "@lcode/shared";
import type { WorktreeBinding } from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { binding as template } from "./sidebar-file-tree-service.js";
export function createSidebarFixtureData(
  origin: string,
  identity: string,
  target: Parameters<typeof buildRemoteWorkspaceIdentity>[1],
) {
  const now = Date.now();
  const tasks = [
    { taskId: "local", title: "本地项目会话" },
    { taskId: "second", title: "第二个项目会话" },
    { taskId: "root-a", title: "工作树主会话", executionBindingId: "tree-a" },
    { taskId: "child", title: "工作树子会话", executionBindingId: "tree-a" },
    { taskId: "remote", title: "远程项目会话", workspaceIdentity: identity },
    {
      taskId: "remote-tree",
      title: "远程工作树会话",
      executionBindingId: "remote-tree",
      workspaceIdentity: identity,
    },
    { taskId: "archived", title: "已归档会话", archivedAt: now },
    {
      taskId: "archived-tree",
      title: "已归档工作树会话",
      executionBindingId: "tree-a",
      archivedAt: now,
    },
    { taskId: "pinned", title: "置顶会话", pinnedAt: now },
    { taskId: "independent", title: "独立讨论", workspacePath: "/fixture/conversations" },
  ].map((task) => ({
    workspacePath: origin,
    provider: "lcode",
    mode: "agent",
    status: "completed",
    createdAt: now - 86400000,
    updatedAt: now,
    ...task,
  })) as LCodeTaskMeta[];
  const bindings: WorktreeBinding[] = [
    {
      ...template,
      id: "tree-a",
      taskId: "root-a",
      originalWorkspacePath: origin,
      workspacePath: "/fixture/tree-a",
      checkoutPath: "/fixture/tree-a",
      branch: "feat/login",
      displayName: "登录优化",
    },
    {
      ...template,
      id: "remote-tree",
      taskId: "remote-tree",
      originalWorkspacePath: origin,
      originalWorkspaceIdentity: identity,
      workspaceIdentity: buildRemoteWorkspaceIdentity("/fixture/remote-tree", target),
      workspacePath: "/fixture/remote-tree",
      checkoutPath: "/fixture/remote-tree",
      branch: "fix/remote",
      displayName: "远程修复",
    },
  ];
  const tabs: WorkspaceTabState[] = [
    {
      id: "project",
      kind: "workspace",
      workspacePath: origin,
      label: "网站项目",
      localProjectId: "project",
    },
    {
      id: "remote",
      kind: "workspace",
      workspacePath: origin,
      workspaceIdentity: identity,
      remoteSessionId: "remote",
      remoteTarget: target,
      label: "远程服务",
    },
    {
      id: "conversation",
      kind: "workspace",
      workspacePath: "/fixture/conversations",
      workspacePurpose: "conversation",
      label: "对话",
    },
  ];
  const facts = {
    selected: "unchanged",
    drafts: 0,
    localReadsForRemote: 0,
    connects: 0,
    finishedReconnects: 0,
    settingsSync: 0,
    creates: [] as unknown[],
    sourceReads: [] as string[],
  };
  return { tasks, bindings, tabs, facts };
}
