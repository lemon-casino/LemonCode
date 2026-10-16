import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemoteWorkspaceIdentity,
  emptySidebarOrganization,
  sidebarEntryKey,
  type LCodeTaskMeta,
  type SidebarEntryRef,
} from "@lcode/shared";
import { taskSidebarRef } from "@/lib/sidebarOrganization.js";
import { projectSidebarFocus, sidebarTaskSourceLabels } from "./sidebarFocusProjection.js";
import type { SidebarCatalogItem } from "@/hooks/useSidebarOrganization.js";

test("focus inherits container chats once, respects explicit placement and keeps original snapshot", () => {
  const origin = { workspacePath: "/fixture/repo" };
  const remote = {
    ...origin,
    workspaceIdentity: buildRemoteWorkspaceIdentity(origin.workspacePath, {
      kind: "ssh",
      host: "example.invalid",
      username: "fixture",
      port: 22,
    }),
  };
  const project: SidebarEntryRef = { kind: "project", ...origin };
  const tree: SidebarEntryRef = { kind: "worktree", origin: remote, bindingId: "tree" };
  const tasks = [
    { ...origin, taskId: "same" },
    { ...origin, taskId: "separate" },
    { ...remote, taskId: "same" },
  ] as LCodeTaskMeta[];
  const catalog: SidebarCatalogItem[] = tasks.map((task) => ({
    ref: taskSidebarRef(task),
    label: task.taskId,
    detail: "fixture",
    naturalParent: task.workspaceIdentity ? tree : project,
  }));
  const snapshot = {
    ...emptySidebarOrganization(),
    sections: [
      { id: "mixed", title: "混合", entries: [project, tree] },
      { id: "separate", title: "独立", entries: [taskSidebarRef(tasks[1]!)] },
      { id: "empty", title: "空分区", entries: [] },
    ],
  };
  const before = structuredClone(snapshot);
  const chats = projectSidebarFocus("chats", snapshot, catalog, tasks);
  assert.equal(chats.sections.length, 2);
  assert.deepEqual(
    chats.sections[0]!.entries.map(sidebarEntryKey),
    [taskSidebarRef(tasks[0]!), taskSidebarRef(tasks[2]!)].map(sidebarEntryKey),
  );
  assert.deepEqual(chats.sections[1]!.entries, [taskSidebarRef(tasks[1]!)]);
  assert.deepEqual(chats.chats, []);
  assert.deepEqual(
    projectSidebarFocus("projects", snapshot, catalog, tasks).sections.map((s) => s.entries),
    [[project]],
  );
  assert.deepEqual(
    projectSidebarFocus("worktrees", snapshot, catalog, tasks).sections.map((s) => s.entries),
    [[tree]],
  );
  assert.equal(projectSidebarFocus("all", snapshot, catalog, tasks).sections.length, 3);
  assert.deepEqual(snapshot, before);
  assert.equal(
    projectSidebarFocus("chats", emptySidebarOrganization(), catalog, [...tasks, tasks[0]!]).chats
      .length,
    3,
  );
  const labels = sidebarTaskSourceLabels([
    ...catalog,
    { ref: project, label: "项目", detail: "本地项目" },
    { ref: tree, label: "远程修复", detail: "远程工作树" },
  ]);
  assert.equal(labels.get(sidebarEntryKey(taskSidebarRef(tasks[2]!))), "远程修复 · 远程工作树");
});
