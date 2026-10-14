import { Event } from "@lcode/rpc";
import { buildRemoteEnvironmentKey } from "@lcode/shared";
import type {
  ILCodeTaskService,
  IServiceAccessor,
  LCodeGroupedTaskViewOrderInput,
  LCodeGroupedTaskViewStructure,
  LCodeTaskGroup,
  LCodeTaskListWorkspaceScope,
} from "@lcode/services";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import {
  resolveWorkspaceServices,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

const PREFIX = "remote-group:";
const scopeKey = (scope: LCodeTaskListWorkspaceScope) =>
  scope.workspaceIdentity?.trim() || scope.workspacePath;
const encodeGroup = (owner: string, id: string) =>
  owner === "local" ? id : `${PREFIX}${encodeURIComponent(JSON.stringify([owner, id]))}`;
function decodeGroup(id: string): [string, string] {
  if (!id.startsWith(PREFIX)) return ["local", id];
  const decoded: unknown = JSON.parse(decodeURIComponent(id.slice(PREFIX.length)));
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    decoded.some((value) => typeof value !== "string" || !value)
  )
    throw new Error("远端分组身份无效");
  return decoded as [string, string];
}

interface GroupedSource {
  key: string;
  service: ILCodeTaskService;
  scopes: LCodeTaskListWorkspaceScope[];
}
const serviceIds = new WeakMap<object, number>();
let nextServiceId = 1;
/** 绑定身份不变时，RPC facade 换代仍须失效分组读取缓存。 */
export function groupedWorkspaceSourceSignature(
  base: IServiceAccessor,
  tabs: WorkspaceTabState[],
  state: WorkspaceServiceResolverState,
): string {
  return JSON.stringify(
    tabs
      .map((tab) => {
        const resolved = resolveWorkspaceServices(tab, base, state);
        const service = resolved?.services.lcodeTaskService;
        if (service && !serviceIds.has(service)) serviceIds.set(service, nextServiceId++);
        return [scopeKey(tab), resolved?.remoteSessionId, service ? serviceIds.get(service) : null];
      })
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  );
}

/** 无独立状态的 owner 路由；所有持久化仍经现有 task service 的事务接口。 */
export function createGroupedWorkspaceTaskService(
  base: IServiceAccessor,
  tabs: WorkspaceTabState[],
  state: WorkspaceServiceResolverState & { sessionsById: Record<string, RemoteWorkspaceSession> },
  active?: LCodeTaskListWorkspaceScope,
): ILCodeTaskService {
  const sources = new Map<string, GroupedSource>();
  const ownerByScope = new Map<string, string>();
  for (const tab of tabs) {
    const resolved = resolveWorkspaceServices(tab, base, state);
    if (!resolved) continue;
    const session = resolved.remoteSessionId
      ? state.sessionsById[resolved.remoteSessionId]
      : undefined;
    const key = session?.target
      ? buildRemoteEnvironmentKey(session.target)
      : resolved.isRemoteWorkspace
        ? tab.workspaceIdentity!
        : "local";
    const source = sources.get(key) ?? {
      key,
      service: resolved.services.lcodeTaskService,
      scopes: [],
    };
    source.scopes.push({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      workspacePurpose: tab.workspacePurpose,
    });
    sources.set(key, source);
    ownerByScope.set(scopeKey(tab), key);
  }
  function sourceForScope(scope: LCodeTaskListWorkspaceScope) {
    const owner = ownerByScope.get(scopeKey(scope));
    const source = owner ? sources.get(owner) : undefined;
    if (!source) throw new Error("分组 workspace source 当前离线");
    return source;
  }
  function sourceForGroup(id: string) {
    const [key, rawId] = decodeGroup(id);
    const source = sources.get(key);
    if (!source) throw new Error("分组 owner 当前离线");
    return { source, rawId };
  }
  function projectGroup(source: GroupedSource, group: LCodeTaskGroup) {
    return { ...group, id: encodeGroup(source.key, group.id) };
  }
  async function groupMutation(
    method: "renameTaskGroup" | "updateTaskGroupColor",
    params: Record<string, unknown> & { groupId: string },
  ) {
    const { source, rawId } = sourceForGroup(params.groupId);
    const command = source.service[method] as (value: unknown) => Promise<LCodeTaskGroup>;
    return projectGroup(
      source,
      await command.call(source.service, {
        ...params,
        groupId: rawId,
        workspaceScopes: source.scopes,
      }),
    );
  }
  const overrides: Partial<ILCodeTaskService> = {
    async createTaskGroup(params) {
      const source = active ? sourceForScope(active) : sources.get("local");
      if (!source) throw new Error("没有可用的分组 owner");
      return projectGroup(source, await source.service.createTaskGroup(params));
    },
    renameTaskGroup: (params) => groupMutation("renameTaskGroup", params),
    updateTaskGroupColor: (params) => groupMutation("updateTaskGroupColor", params),
    async deleteTaskGroup(params) {
      const { source, rawId } = sourceForGroup(params.groupId);
      await source.service.deleteTaskGroup({ groupId: rawId, workspaceScopes: source.scopes });
    },
    async listGroupedTaskViewStructure(params) {
      // 先验证全部 scope，不能把未绑定远端默认为本机，也不能发布不完整快照。
      params.workspaceScopes.forEach(sourceForScope);
      const results = await Promise.all(
        [...sources.values()].map(async (source) => {
          const scopes = params.workspaceScopes.filter(
            (scope) => ownerByScope.get(scopeKey(scope)) === source.key,
          );
          if (!scopes.length)
            return {
              groups: [],
              members: [],
              topLevelOrders: [],
            } satisfies LCodeGroupedTaskViewStructure;
          const view = await source.service.listGroupedTaskViewStructure({
            workspaceScopes: scopes,
          });
          return {
            groups: view.groups.map((group) => projectGroup(source, group)),
            members: view.members.map((member) => ({
              ...member,
              groupId: encodeGroup(source.key, member.groupId),
            })),
            topLevelOrders: view.topLevelOrders.map((node) =>
              node.type === "group"
                ? { ...node, groupId: encodeGroup(source.key, node.groupId) }
                : node,
            ),
          };
        }),
      );
      return {
        groups: results.flatMap((view) => view.groups),
        members: results.flatMap((view) => view.members),
        topLevelOrders: results.flatMap((view) => view.topLevelOrders),
      };
    },
    async applyGroupedTaskViewOrder(params) {
      params.workspaceScopes.forEach(sourceForScope);
      const groups = params.groups.map((group) => {
        const { source, rawId } = sourceForGroup(group.groupId);
        // 不同 tasks-index 之间没有同一组事务；所有跨 owner 成员移动必须在任何写入前拒绝。
        if (group.taskRefs.some((task) => sourceForScope(task).key !== source.key))
          throw new Error("不能跨连接移动分组成员");
        return { source, groupId: rawId, taskRefs: group.taskRefs };
      });
      const nodes = params.topLevelNodes.map((node) =>
        node.type === "group"
          ? {
              source: sourceForGroup(node.groupId).source,
              node: { ...node, groupId: sourceForGroup(node.groupId).rawId },
            }
          : { source: sourceForScope(node.task), node },
      );
      const inputs = [...sources.values()].map((source) => ({
        source,
        input: {
          workspaceScopes: source.scopes,
          topLevelNodes: nodes
            .filter((node) => node.source.key === source.key)
            .map((node) => node.node),
          groups: groups
            .filter((group) => group.source.key === source.key)
            .map(({ groupId, taskRefs }) => ({ groupId, taskRefs })),
        } satisfies LCodeGroupedTaskViewOrderInput,
      }));
      await Promise.all(
        inputs.map(({ source, input }) => source.service.applyGroupedTaskViewOrder(input)),
      );
      return { nodes: [] };
    },
    async listPinnedTaskIds() {
      return (
        await Promise.all([...sources.values()].map((source) => source.service.listPinnedTaskIds()))
      ).flat();
    },
    listTasks: (params) => sourceForScope(params).service.listTasks(params),
    listPinnedTasks: (params) => sourceForScope(params).service.listPinnedTasks(params),
    listArchivedTasks: (params) => sourceForScope(params).service.listArchivedTasks(params),
    listDeletedTaskIds: (params) => sourceForScope(params).service.listDeletedTaskIds(params),
    onDynamicWorkspaceEvent: (params) => {
      const scope = typeof params === "string" ? { workspacePath: params } : params;
      try {
        return sourceForScope(scope).service.onDynamicWorkspaceEvent(scope);
      } catch {
        return Event.None;
      }
    },
  };
  return new Proxy(base.lcodeTaskService, {
    get(target, property) {
      const replacement = Reflect.get(overrides, property);
      if (replacement) return replacement;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
