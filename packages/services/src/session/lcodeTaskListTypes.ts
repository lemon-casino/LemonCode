import type { WorkspacePurpose, LCodeTaskMeta } from "@lcode/shared";

export type LCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type LCodeTaskListSortBy = "created" | "updated";

export interface LCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface LCodeTaskListQuery {
  kind: LCodeTaskListKind;
  workspaceScopes: LCodeTaskListWorkspaceScope[];
  sortBy: LCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type LCodeTaskListItem = LCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface LCodeTaskListResult {
  items: LCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type LCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface LCodeTaskGroup {
  id: string;
  title: string;
  color: LCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface LCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type LCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: LCodeGroupedTaskRef };

export type LCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: LCodeTaskGroup;
      tasks: LCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: LCodeTaskListItem;
      sortOrder?: number;
    };

export interface LCodeGroupedTaskView {
  nodes: LCodeGroupedTaskViewNode[];
}

export interface LCodeGroupedTaskViewQuery {
  workspaceScopes: LCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// ── grouped 原始结构（不 join tasks 表）──
// grouped 视图的任务数据源迁到 sessions-index 后，服务端只提供分组结构
// （task_groups / task_group_members / task_group_view_node_orders），
// 由客户端与 sessions-index 会话做 join。

/** 组成员引用（不含任务 meta；task 内容由 sessions-index 提供）。 */
export interface LCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** 服务端口径 workspaceKey（resolveWorkspaceKey：identity ?? path），join 匹配键。 */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = 尚未落 sort_order（新加入组）；客户端按 addedAt 降序补内存序。 */
  sortOrder: number | null;
  addedAt: number;
}

/** 顶层节点排序（task_group_view_node_orders，node_key 已解析为结构化引用）。 */
export type LCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface LCodeGroupedTaskViewStructure {
  /** 已按 workspaceScopes 可见性过滤的 group（bootstrap workspace group 只在其 workspace 可见）。 */
  groups: LCodeTaskGroup[];
  /** 全量组成员（含不可见 group 的成员——顶层排除规则需要全量判断）。 */
  members: LCodeGroupedTaskViewStructureMember[];
  topLevelOrders: LCodeGroupedTaskViewStructureTopOrder[];
}

export interface LCodeGroupedTaskViewOrderInput {
  workspaceScopes: LCodeTaskListWorkspaceScope[];
  topLevelNodes: LCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: LCodeGroupedTaskRef[];
  }>;
}

export interface LCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
