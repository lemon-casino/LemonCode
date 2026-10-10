import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeBinding } from "@lcode/services";
import type { LCodeTaskMeta } from "@lcode/shared";
import {
  isWorktreeSidebarTask,
  filterOrdinaryGroupedView,
  isWorktreeSidebarWorkspace,
  isTaskInSidebarBinding,
  worktreeBindingAnnouncementSignature,
} from "./worktreeSidebar.js";

const binding = {
  id: "tree-a",
  taskId: "owner",
  originalWorkspacePath: "/repo",
  originalWorkspaceIdentity: "remote-a",
  workspacePath: "/checkout",
  workspaceIdentity: "tree-remote-a",
  checkoutPath: "/checkout",
  status: "ready",
} as WorktreeBinding;
const task = (taskId: string, fields: Partial<LCodeTaskMeta> = {}) =>
  ({
    taskId,
    title: taskId,
    workspacePath: "/repo",
    workspaceIdentity: "remote-a",
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  }) as LCodeTaskMeta;

test("sidebar classification uses exact bindings and identities, never path names", () => {
  assert.equal(
    isWorktreeSidebarTask(task("fork", { executionBindingId: "tree-a" }), [binding]),
    true,
  );
  assert.equal(isWorktreeSidebarTask(task("unknown", { executionBindingId: "missing" }), []), true);
  assert.equal(isWorktreeSidebarTask(task("owner"), [binding]), true);
  assert.equal(
    isWorktreeSidebarTask(task("owner", { workspaceIdentity: "remote-b" }), [binding]),
    false,
  );
  assert.equal(
    isWorktreeSidebarTask(
      task("local", { workspacePath: "/checkout", workspaceIdentity: "tree-remote-a" }),
      [binding],
    ),
    true,
  );
  assert.equal(
    isWorktreeSidebarTask(task("ordinary", { workspacePath: "/worktrees/checkouts/project" }), [
      binding,
    ]),
    false,
  );
  assert.equal(
    isWorktreeSidebarWorkspace({ workspacePath: "/checkout", workspaceIdentity: "tree-remote-a" }, [
      binding,
    ]),
    true,
  );
  assert.equal(
    isWorktreeSidebarWorkspace({ workspacePath: "/checkout", workspaceIdentity: "tree-remote-b" }, [
      binding,
    ]),
    false,
  );
});

test("ordinary group projection preserves source membership and hidden order facts", () => {
  const ordinary = task("ordinary");
  const managed = task("owner");
  const original = {
    nodes: [
      { type: "group", group: { id: "group" }, tasks: [managed, ordinary], sortOrder: 7 },
      { type: "task", task: managed, sortOrder: 8 },
    ],
  } as Parameters<typeof filterOrdinaryGroupedView>[0];
  const projection = filterOrdinaryGroupedView(original, [binding]);
  const projectedGroup = projection.nodes[0]!;
  const originalGroup = original.nodes[0]!;
  assert.equal(projection.nodes.length, 1);
  assert.deepEqual(projectedGroup.type === "group" ? projectedGroup.tasks : [], [ordinary]);
  assert.equal(original.nodes.length, 2);
  assert.equal(originalGroup.type === "group" ? originalGroup.tasks.length : 0, 2);
  assert.equal(projectedGroup.sortOrder, 7);
});

test("execution checkout roots are classified from owner facts and foreign explicit bindings remain separate", () => {
  assert.equal(
    isTaskInSidebarBinding(
      task("foreign", {
        workspacePath: "/checkout",
        workspaceIdentity: "tree-remote-a",
        executionBindingId: "foreign",
      }),
      binding,
    ),
    false,
  );
  assert.equal(
    isWorktreeSidebarWorkspace({ workspacePath: "/checkout" }, [
      {
        ...binding,
        workspacePath: "/checkout/packages/app",
        workspaceIdentity: undefined,
        originalWorkspaceIdentity: undefined,
      },
    ]),
    true,
  );
});

test("preparation polling announces only the first read and real lifecycle transitions", () => {
  const scope = "/repo";
  const preparing = { id: "tree-a", status: "preparing" };
  const ready = { id: "tree-a", status: "ready" };
  const first = worktreeBindingAnnouncementSignature(scope, preparing);
  assert.equal(worktreeBindingAnnouncementSignature(scope, { ...preparing }), first);
  assert.notEqual(worktreeBindingAnnouncementSignature(scope, ready), first);
  assert.notEqual(
    worktreeBindingAnnouncementSignature(scope, { id: "tree-b", status: "preparing" }),
    first,
  );
  assert.notEqual(worktreeBindingAnnouncementSignature("/other", preparing), first);
  // 未读到 binding 不产生签名，避免把"暂时读不到"当成新增工作树广播出去。
  assert.equal(worktreeBindingAnnouncementSignature(scope, null), null);
  assert.equal(worktreeBindingAnnouncementSignature(scope, undefined), null);
});
