import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("fork registration persists one root owner and resolves both scopes after restart", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  const request = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  assert.equal((await f.service.prepare(request)).id, owner.id);
  assert.equal((await f.service.prepare(request)).taskId, "owner");
  const reopened = createWorktreeService(f.options);
  assert.equal(
    (await reopened.getBinding({ workspacePath: f.repo, taskId: "child" }))?.id,
    owner.id,
  );
  assert.equal(
    (await reopened.getBinding({ workspacePath: owner.workspacePath, taskId: "child" }))?.id,
    owner.id,
  );
  assert.equal((await reopened.list({ workspacePath: f.repo })).length, 1);
});

test("fork descendants require a registered parent and cannot change checkout", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  const second = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "second",
    requestId: "second",
  });
  const child = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  await f.service.prepare(child);
  await assert.rejects(
    f.service.prepare({
      ...child,
      parentBinding: { bindingId: second.id, bindingOwnerTaskId: "second", parentTaskId: "second" },
    }),
    /cannot change/,
  );
  await assert.rejects(
    f.service.prepare({
      ...child,
      taskId: "grandchild",
      parentBinding: { ...child.parentBinding, parentTaskId: "unknown" },
    }),
    /not registered/,
  );
  assert.equal(
    (
      await f.service.prepare({
        ...child,
        taskId: "grandchild",
        parentBinding: { ...child.parentBinding, parentTaskId: "child" },
      })
    ).id,
    owner.id,
  );
  await assert.rejects(
    f.service.prepare({ workspacePath: f.repo, taskId: "child", requestId: "new-tree" }),
    /already uses/,
  );
});

test("fork registration rejects foreign origins and independent child owners", async (t) => {
  const f = await fixture(t);
  const owner = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  await f.service.prepare({ workspacePath: f.repo, taskId: "child", requestId: "child" });
  const request = {
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: owner.id, bindingOwnerTaskId: "owner", parentTaskId: "owner" },
  };
  await assert.rejects(f.service.prepare(request), /already owns/);
  await assert.rejects(
    f.service.prepare({ ...request, taskId: "foreign", workspacePath: join(f.root, "other") }),
    /original workspace/,
  );
  await assert.rejects(f.service.prepare({ ...request, taskId: "owner" }), /own task ID/);
});
