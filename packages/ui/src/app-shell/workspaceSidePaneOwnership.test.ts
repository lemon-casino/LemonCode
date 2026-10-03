import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity, replaceRemoteWorkspaceIdentityPath } from "@lcode/shared";
import {
  getVisibleSidePaneTabs,
  openCodeViewerSidePane,
  stampSidePaneTabsOwnership,
} from "../lib/workspaceSidePane.js";

test("审核标签页按原项目与会话隔离，实际文件路径和远程身份保持不变", () => {
  const remoteIdentity = buildRemoteWorkspaceIdentity("/repo", {
    kind: "ssh",
    host: "fixture.example.invalid",
    port: 22,
    username: "fixture",
  });
  for (const originalIdentity of [undefined, remoteIdentity]) {
    const workspacePath = "/repo";
    const checkoutPath = "/worktrees/task-a";
    const executionIdentity = originalIdentity
      ? replaceRemoteWorkspaceIdentityPath(originalIdentity, checkoutPath)!
      : undefined;
    const owner = { workspaceKey: originalIdentity ?? workspacePath, ownerTaskId: "a" };
    const source = {
      type: "patch" as const,
      title: "变更文件与范围",
      patch: "",
      reviewFiles: [{ path: "a.ts" }],
      reviewReturnToken: "review-a",
      workspacePath: checkoutPath,
      workspaceIdentity: executionIdentity,
      workspaceRemoteSessionId: originalIdentity ? "attachment-fixture" : undefined,
    };
    const state = stampSidePaneTabsOwnership(openCodeViewerSidePane(null, source, "a"), owner)!;
    assert.equal(getVisibleSidePaneTabs(state.tabs, owner).length, 1);
    assert.equal(
      getVisibleSidePaneTabs(state.tabs, {
        workspaceKey: executionIdentity ?? checkoutPath,
        ownerTaskId: "a",
      }).length,
      0,
      "执行身份不能替代面板 owner；此前显示层使用这里的 scope 导致变更页被误隐藏",
    );
    assert.equal(getVisibleSidePaneTabs(state.tabs, { ...owner, ownerTaskId: "b" }).length, 0);
    assert.equal(
      getVisibleSidePaneTabs(state.tabs, { ...owner, workspaceKey: "other-project" }).length,
      0,
    );
    assert.equal(getVisibleSidePaneTabs(state.tabs, owner).length, 1, "切回原会话仍可看到标签页");
    const tab = state.tabs[0]!;
    assert.equal(tab.type, "code-viewer");
    if (tab.type === "code-viewer") assert.deepEqual(tab.source, source);
  }
});
