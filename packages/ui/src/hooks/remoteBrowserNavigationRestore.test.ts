import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "@lcode/shared";
import type { IServiceAccessor } from "@lcode/services";
import { createTabStore } from "@/store/tabStore.js";
import { useLCodeSessionStore } from "@/store/lcodeSessionStore.js";
import { restoreRemoteBrowserNavigation } from "./remoteBrowserNavigationRestore.js";

const settings = appSettingsSchema.parse({
  localProjects: [
    { id: "project-b", name: "B", primaryFolderPath: "/b", sourceFolderPaths: ["/b"] },
  ],
  lastWorkspaceSession: [
    { kind: "local", workspacePath: "/a" },
    { kind: "local", workspacePath: "/b", localProjectId: "project-b" },
  ],
  lastActiveTabIndex: 0,
});
function host(taskExists = true) {
  return {
    fileService: {
      stat: async () => ({ type: "directory" }),
      ensureConversationWorkspace: async () => ({ path: "/default" }),
    },
    lcodeTaskService: { getTaskMeta: async () => (taskExists ? { taskId: "b2" } : null) },
  } as unknown as IServiceAccessor;
}
const target = { workspacePath: "/b", localProjectId: "project-b", taskId: "b2" };

test("浏览器位置优先于桌面激活项目，缺失会话只回到原项目草稿", async () => {
  for (const exists of [true, false]) {
    const tabs = createTabStore(null);
    await restoreRemoteBrowserNavigation({
      settings,
      target,
      services: host(exists),
      tabStoreApi: tabs,
    });
    assert.equal(tabs.getState().activeWorkspacePath, "/b");
    assert.equal(
      useLCodeSessionStore.getState().getWorkspaceState("/b").activeTaskId,
      exists ? "b2" : null,
    );
  }
});

test("已移除项目不能通过同路径新项目复活，identity 不回落到路径", async () => {
  for (const stale of [
    { ...target, localProjectId: "deleted-project" },
    { ...target, workspaceIdentity: "other-host:/b", remoteSessionId: "other-attachment" },
  ]) {
    const tabs = createTabStore(null);
    await restoreRemoteBrowserNavigation({
      settings,
      target: stale,
      services: host(),
      tabStoreApi: tabs,
    });
    assert.equal(tabs.getState().activeWorkspacePath, "/default");
    assert.equal(useLCodeSessionStore.getState().getWorkspaceState("/default").activeTaskId, null);
  }
});

test("目录不存在时进入默认草稿，网络错误保持可区分且迟到结果不写入", async () => {
  const missing = host();
  missing.fileService.stat = async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const tabs = createTabStore(null);
  await restoreRemoteBrowserNavigation({ settings, target, services: missing, tabStoreApi: tabs });
  assert.equal(tabs.getState().activeWorkspacePath, "/default");
  const disconnected = host();
  disconnected.lcodeTaskService.getTaskMeta = async () => {
    throw new Error("disconnected");
  };
  await assert.rejects(
    restoreRemoteBrowserNavigation({
      settings,
      target,
      services: disconnected,
      tabStoreApi: createTabStore(null),
    }),
    /disconnected/,
  );
  const cancelled = createTabStore(null);
  await restoreRemoteBrowserNavigation({
    settings,
    target,
    services: host(),
    tabStoreApi: cancelled,
    isCurrent: () => false,
  });
  assert.equal(cancelled.getState().tabs.length, 0);
});
