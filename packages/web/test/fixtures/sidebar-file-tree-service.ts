import type { IServiceAccessor, WorktreeBinding } from "@lcode/services";
import { services as layoutServices } from "./mobile-layout-data.js";

const noop = () => {};
const subscribe = () => ({ dispose: noop });
export const origin = "/fixture/file-project";
export const calls: Array<{ endpoint: string; path: string }> = [];
export const facts = { newTasks: 0, sessionReads: 0, failFiles: false, pendingSession: false };
export const binding: WorktreeBinding = {
  id: "tree",
  taskId: "cold-session",
  requestId: "tree-request",
  originalWorkspacePath: origin,
  workspacePath: "/fixture/file-checkout",
  checkoutPath: "/fixture/file-checkout",
  repositoryRoot: origin,
  commonDirectory: `${origin}/.git`,
  branch: "worktree/files",
  targetBranch: "main",
  baseCommit: "a".repeat(40),
  sourceFolderPaths: [origin],
  status: "ready",
  createdAt: "now",
  updatedAt: "now",
};

export function createFileServices(endpoint: string): IServiceAccessor {
  return {
    ...layoutServices,
    fileService: {
      readdir: async ({ path }: { path: string }) => {
        calls.push({ endpoint, path });
        if (facts.failFiles) throw new Error("fixture file permission denied");
        return [{ name: `${endpoint}.ts`, path: `${path}/${endpoint}.ts`, type: "file" }];
      },
    },
    fileWatcherService: {
      watch: async () => ({ id: "fixture-watch" }),
      unwatch: async () => {},
      onDynamicChange: () => subscribe,
    },
    gitService: {
      refresh: async () => ({
        summary: { workspacePath: origin, isRepository: false, isGitAvailable: false },
        unstagedChanges: [],
        stagedChanges: [],
      }),
      getIgnoredPaths: async () => [],
    },
    worktreeService: { list: async () => [], getBinding: async () => null },
    lcodeSessionService: {
      readSession: async () => {
        facts.sessionReads++;
        if (facts.pendingSession) return new Promise<never>(() => {});
        throw new Error("Session is not active: cold-session");
      },
    },
    lcodeTaskService: {
      listTasks: async () => ({ items: [], total: 0, hasMore: false }),
      listPinnedTasks: async () => ({ items: [], total: 0, hasMore: false }),
      listArchivedTasks: async () => ({ items: [], total: 0, hasMore: false }),
      listPinnedTaskIds: async () => [],
      listDeletedTaskIds: async () => [],
      listGroupedTaskViewStructure: async () => ({ groups: [], members: [], topLevelOrders: [] }),
      onDynamicWorkspaceEvent: () => subscribe,
      onTaskUpdated: subscribe,
    },
    windowControllerService: {
      onDynamicControllerFrame: () => subscribe,
      subscribeControllerV4: async () => ({ ack: { subscriptionId: "file-fixture" } }),
      unsubscribeControllerV4: async () => {},
      listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    },
  } as unknown as IServiceAccessor;
}

export const services = createFileServices("local");
