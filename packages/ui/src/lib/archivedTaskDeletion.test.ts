import assert from "node:assert/strict";
import test from "node:test";
import type { LCodeTaskMeta } from "@lcode/shared";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
} from "./archivedTaskDeletion.js";
test("category bulk deletion never includes hidden worktree/ordinary tasks", async () => {
  const deleted: string[][] = [];
  const tasks = [
    { taskId: "ordinary" },
    { taskId: "tree", executionBindingId: "tree" },
  ] as LCodeTaskMeta[];
  const workspaces = [
    {
      workspacePath: "/repo",
      label: "repo",
      service: {
        listArchivedTasks: async () => tasks,
        deleteArchivedTasks: async ({ taskIds }: { taskIds: string[] }) => {
          deleted.push(taskIds);
          return { deletedTaskIds: taskIds, skippedTaskIds: [], failedTaskIds: [] };
        },
      },
    },
  ];
  const selection = await collectArchivedTaskDeletion(
    workspaces,
    (task) => !task.executionBindingId,
  );
  assert.equal(selection.count, 1);
  await deleteArchivedTaskSelection(selection, () => {});
  assert.deepEqual(deleted, [["ordinary"]]);
});
