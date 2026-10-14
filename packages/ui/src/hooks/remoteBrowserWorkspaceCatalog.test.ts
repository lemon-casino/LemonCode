import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@lcode/rpc";
import {
  appSettingsSchema,
  buildRemoteWorkspaceIdentity,
  type WindowWorkspaceCatalogEntry,
} from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { restoreRemoteBrowserNavigation } from "./remoteBrowserNavigationRestore.js";
import { createRemoteBrowserWorkspaceCatalog } from "./remoteBrowserWorkspaceCatalog.js";

test("窗口目录绑定三种同路径 remote，换代后的浏览位置/任务验证只查正确 owner", async () => {
  const changes = new Emitter<WindowWorkspaceCatalogEntry[]>();
  const targets = [
    { kind: "ssh" as const, host: "example.invalid", username: "fixture" },
    { kind: "wsl" as const, distro: "FixtureDistro" },
    { kind: "docker" as const, container: "fixture-container" },
  ];
  let catalog: WindowWorkspaceCatalogEntry[] = targets.map((target, index) => ({
    scope: {
      kind: "remote",
      workspacePath: "/same",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/same", target),
      remoteSessionId: `session-${index}`,
      generation: 1,
    },
    target,
    sourceAvailability: "online",
  }));
  const reads: string[] = [];
  const services = {
    windowWorkspaceService: { getCatalog: async () => catalog, onDidChangeCatalog: changes.event },
    createWorkspaceServiceAccessor: (scope: WindowWorkspaceCatalogEntry["scope"]) => ({
      fileService: {
        stat: async () => {
          reads.push(scope.remoteSessionId);
          return { type: "directory" };
        },
      },
      lcodeTaskService: {
        getTaskMeta: async () => {
          reads.push(scope.remoteSessionId);
          return { taskId: "task" };
        },
      },
    }),
    fileService: {
      ensureConversationWorkspace: async () => ({ path: "/default" }),
      stat: async () => {
        throw new Error("不能查询本机同路径");
      },
    },
    lcodeTaskService: {
      getTaskMeta: async () => {
        throw new Error("不能查询本机同路径任务");
      },
    },
  } as unknown as IServiceAccessor;
  const tabs = createTabStore(null);
  const projection = createRemoteBrowserWorkspaceCatalog(services, tabs);
  await projection.prepare();
  projection.reconcile();
  assert.equal(tabs.getState().tabs.filter(isWorkspaceTab).length, 3);
  const original = catalog[1];
  assert.ok(original);
  catalog = catalog.map((entry) =>
    entry === original
      ? { ...entry, scope: { ...entry.scope, remoteSessionId: "new-wsl-session", generation: 2 } }
      : entry,
  );
  changes.fire(catalog);
  assert.equal(
    useRemoteWorkspaceSessionStore.getState().sessionsById[original.scope.remoteSessionId],
    undefined,
  );
  const settings = appSettingsSchema.parse({
    lastWorkspaceSession: targets.map((target, index) => ({
      kind: "remote",
      workspacePath: "/same",
      workspaceIdentity: catalog[index]!.scope.workspaceIdentity,
      target,
      lastOpenedAt: 1,
      lastConnectionStatus: "connected",
    })),
  });
  await restoreRemoteBrowserNavigation({
    settings,
    services,
    tabStoreApi: tabs,
    target: {
      workspacePath: "/same",
      workspaceIdentity: original.scope.workspaceIdentity,
      remoteSessionId: original.scope.remoteSessionId,
      taskId: "task",
    },
  });
  projection.reconcile();
  assert.equal(tabs.getState().activeWorkspaceIdentity, original.scope.workspaceIdentity);
  assert.deepEqual(reads, ["new-wsl-session", "new-wsl-session"]);
  changes.fire(catalog.map((entry) => ({ ...entry, sourceAvailability: "offline" })));
  assert.equal(
    tabs
      .getState()
      .tabs.filter(isWorkspaceTab)
      .some((tab) => tab.remoteSessionId),
    false,
  );
  assert.equal(Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById).length, 0);
  projection.dispose();
  changes.dispose();
});

test("目录读取迟到不能覆盖新事件，卸载也不能注册新 facade", async () => {
  const changes = new Emitter<WindowWorkspaceCatalogEntry[]>();
  let resolve!: (value: WindowWorkspaceCatalogEntry[]) => void;
  const target = { kind: "docker" as const, container: "fixture-container" };
  const entry: WindowWorkspaceCatalogEntry = {
    scope: {
      kind: "remote",
      workspacePath: "/same",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/same", target),
      remoteSessionId: "current",
      generation: 2,
    },
    target,
    sourceAvailability: "online",
  };
  const services = {
    windowWorkspaceService: {
      getCatalog: () =>
        new Promise<WindowWorkspaceCatalogEntry[]>((value) => {
          resolve = value;
        }),
      onDidChangeCatalog: changes.event,
    },
    createWorkspaceServiceAccessor: () => ({}),
  } as unknown as IServiceAccessor;
  const projection = createRemoteBrowserWorkspaceCatalog(services, createTabStore(null));
  const read = projection.prepare();
  changes.fire([entry]);
  resolve([{ ...entry, scope: { ...entry.scope, remoteSessionId: "stale", generation: 1 } }]);
  await read;
  assert.ok(useRemoteWorkspaceSessionStore.getState().sessionsById.current);
  assert.equal(useRemoteWorkspaceSessionStore.getState().sessionsById.stale, undefined);
  const late = projection.prepare();
  projection.dispose();
  resolve([entry]);
  await late;
  assert.equal(useRemoteWorkspaceSessionStore.getState().sessionsById.current, undefined);
  changes.dispose();
});
