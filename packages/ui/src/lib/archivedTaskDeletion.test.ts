import assert from "node:assert/strict";
import test from "node:test";
import type { LCodeTaskMeta } from "@lcode/shared";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
} from "./archivedTaskDeletion.js";

function createWorkspace(overrides: Partial<{ workspacePath: string; label: string }> = {}) {
  const deleted: string[][] = [];
  return {
    deleted,
    entry: {
      workspacePath: overrides.workspacePath ?? "/repo",
      label: overrides.label ?? "repo",
      service: {
        deleteArchivedTasks: async ({ taskIds }: { taskIds: string[] }) => {
          deleted.push(taskIds);
          return { deletedTaskIds: taskIds, skippedTaskIds: [], failedTaskIds: [] };
        },
      },
    },
  };
}

test("选择集取自归档列表已渲染的行，工作树会话不再被漏掉", async () => {
  // 根因回归：tasks-index 原始行不持久化 executionBindingId，过去删除侧重新查询并分类，
  // 会把工作树会话全部滤掉。现在选择集直接来自列表投影行，两者必然一致。
  const { deleted, entry } = createWorkspace();
  const visibleTasks = [
    { taskId: "ordinary", workspacePath: "/repo" },
    { taskId: "tree", workspacePath: "/repo", executionBindingId: "tree" },
  ] as LCodeTaskMeta[];

  const selection = collectArchivedTaskDeletion([entry], visibleTasks);
  assert.equal(selection.count, 2);
  assert.deepEqual(selection.unavailableWorkspaces, []);

  await deleteArchivedTaskSelection(selection, () => {});
  assert.deepEqual(deleted, [["ordinary", "tree"]]);
});

test("选择集只覆盖列表传入的行，不会连带删除分类隐藏的会话", async () => {
  const { deleted, entry } = createWorkspace();
  // 列表处于普通分类，只渲染了普通任务。
  const visibleTasks = [{ taskId: "ordinary", workspacePath: "/repo" }] as LCodeTaskMeta[];

  const selection = collectArchivedTaskDeletion([entry], visibleTasks);
  assert.equal(selection.count, 1);
  await deleteArchivedTaskSelection(selection, () => {});
  assert.deepEqual(deleted, [["ordinary"]]);
});

test("同一 taskId 只收集一次，跨 workspace 按 scope 分组", async () => {
  const repo = createWorkspace();
  const other = createWorkspace({ workspacePath: "/other", label: "other" });
  const visibleTasks = [
    { taskId: "a", workspacePath: "/repo" },
    { taskId: "a", workspacePath: "/repo" },
    { taskId: "b", workspacePath: "/other" },
  ] as LCodeTaskMeta[];

  const selection = collectArchivedTaskDeletion([repo.entry, other.entry], visibleTasks);
  assert.equal(selection.count, 2);
  assert.equal(selection.groups.length, 2);
  await deleteArchivedTaskSelection(selection, () => {});
  assert.deepEqual(repo.deleted, [["a"]]);
  assert.deepEqual(other.deleted, [["b"]]);
});

test("远端项目解析不到 Host service 时记为不可用且不发删除请求", async () => {
  const reachable = createWorkspace();
  const unreachable = { workspacePath: "/remote", label: "remote" };
  const visibleTasks = [
    { taskId: "local", workspacePath: "/repo" },
    { taskId: "remote-task", workspacePath: "/remote" },
  ] as LCodeTaskMeta[];

  const selection = collectArchivedTaskDeletion([reachable.entry, unreachable], visibleTasks);
  assert.equal(selection.count, 1);
  assert.deepEqual(selection.unavailableWorkspaces, ["remote"]);

  await deleteArchivedTaskSelection(selection, () => {});
  assert.deepEqual(reachable.deleted, [["local"]]);
});

test("列表为空时不产生选择集，调用方据此提示暂无归档任务", () => {
  const { entry } = createWorkspace();
  const selection = collectArchivedTaskDeletion([entry], []);
  assert.equal(selection.count, 0);
  assert.deepEqual(selection.groups, []);
});
