import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./testFixture.js";
import { createWorktreeService } from "./node.js";

test("management settings persist; project and custom roots do not move existing bindings", async (t) => {
  const f = await fixture(t);
  const initial = await f.service.getManagementSettings();
  assert.equal(initial.autoDeleteEnabled, true);
  await assert.rejects(f.service.updateManagementSettings({ retainedCount: 0 }));
  await assert.rejects(
    f.service.updateManagementSettings({ rootLocation: "custom", rootDirectory: "../outside" }),
  );
  const first = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "first",
    requestId: "first",
  });
  await f.service.updateManagementSettings({ rootLocation: "project", autoDeleteEnabled: false });
  const second = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "second",
    requestId: "second",
  });
  assert.equal(second.checkoutPath, join(f.repo, ".lcode", "worktrees", "checkouts", second.id));
  assert.equal(await f.command(f.repo, "status", "--porcelain", "--untracked-files=all"), "");
  const custom = join(f.root, "custom trees");
  await f.service.updateManagementSettings({ rootLocation: "custom", rootDirectory: custom });
  const third = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "third",
    requestId: "third",
  });
  assert.equal(third.checkoutPath, join(custom, third.id));
  const restarted = createWorktreeService(f.options);
  assert.equal((await restarted.getManagementSettings()).rootDirectory, custom);
  assert.equal(
    (await restarted.rename({ bindingId: second.id, displayName: "短名称" })).branch,
    second.branch,
  );
  for (const binding of [first, second, third]) {
    await restarted.archive({ bindingId: binding.id, requestId: `archive-${binding.id}` });
    await assert.rejects(
      restarted.assertExecutionAdmission({ workspacePath: binding.workspacePath }),
      /fenced/,
    );
    const restored = await restarted.restore({
      bindingId: binding.id,
      requestId: `restore-${binding.id}`,
    });
    assert.equal(restored.checkoutPath, binding.checkoutPath);
    assert.equal(await readFile(join(restored.checkoutPath, "file.txt"), "utf8"), "baseline\n");
  }
});

test("redirecting a custom checkout root never authorizes removing the external tree", async (t) => {
  const f = await fixture(t);
  const root = join(f.root, "custom");
  const outside = join(f.root, "outside");
  await f.service.updateManagementSettings({ rootLocation: "custom", rootDirectory: root });
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
  });
  await mkdir(join(outside, binding.id), { recursive: true });
  await writeFile(join(outside, binding.id, "keep.txt"), "external content");
  await rename(root, `${root}-original`);
  await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    f.service.archive({ bindingId: binding.id, requestId: "archive" }),
    /redirected/,
  );
  assert.equal(await readFile(join(outside, binding.id, "keep.txt"), "utf8"), "external content");
});

test("retention snapshots changes, skips a busy checkout, and never discards sessions", async (t) => {
  const f = await fixture(t);
  await f.service.updateManagementSettings({ retainedCount: 1 });
  const first = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "first",
    requestId: "first",
  });
  await writeFile(join(first.checkoutPath, "file.txt"), "saved changes\n");
  const lease = await f.service.acquireCheckout({
    workspacePath: first.checkoutPath,
    ownerId: "active-turn",
    mode: "shared",
  });
  const second = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "second",
    requestId: "second",
  });
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "first" }))?.status,
    "ready",
  );
  const busy = await f.service.cleanup();
  assert.deepEqual(busy.archivedIds, []);
  assert.equal(busy.skipped[0]?.bindingId, first.id);
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "second" }))?.status,
    "ready",
  );
  await f.service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  const result = await f.service.cleanup();
  assert.deepEqual(result.archivedIds, [first.id]);
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "second" }))?.status,
    "ready",
  );
  const restored = await f.service.restore({ bindingId: first.id, requestId: "restore" });
  assert.ok(restored.snapshot);
  assert.equal(restored.deletion, undefined);
  assert.equal(await readFile(join(restored.checkoutPath, "file.txt"), "utf8"), "saved changes\n");
  await f.service.updateManagementSettings({ autoDeleteEnabled: false });
  assert.deepEqual((await f.service.cleanup()).archivedIds, []);
  assert.notEqual(first.id, second.id);
});

test("automatic retention preserves ignored content and never changes the newer tree", async (t) => {
  const f = await fixture(t);
  await f.service.updateManagementSettings({ retainedCount: 1 });
  const first = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "first",
    requestId: "first",
  });
  await writeFile(join(first.checkoutPath, ".gitignore"), "private.txt\n");
  await writeFile(join(first.checkoutPath, "private.txt"), "preserve ignored content\n");
  await f.service.prepare({ workspacePath: f.repo, taskId: "second", requestId: "second" });
  const result = await f.service.cleanup();
  assert.deepEqual(result.archivedIds, []);
  assert.equal(result.skipped[0]?.bindingId, first.id);
  assert.match(result.skipped[0]?.reason ?? "", /acknowledgement/);
  assert.equal(
    await readFile(join(first.checkoutPath, "private.txt"), "utf8"),
    "preserve ignored content\n",
  );
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "first" }))?.status,
    "ready",
  );
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "second" }))?.status,
    "ready",
  );
});

test("blank child alias is queryable by its own request and cannot cross workspace identities", async (t) => {
  const f = await fixture(t);
  const parent = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner-request",
  });
  const request = {
    workspacePath: f.repo,
    taskId: "blank",
    requestId: "blank-request",
    parentBinding: {
      bindingId: parent.id,
      bindingOwnerTaskId: parent.taskId,
      parentTaskId: parent.taskId,
    },
  };
  assert.equal((await f.service.prepare(request)).id, parent.id);
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, requestId: "blank-request" }))?.id,
    parent.id,
  );
  assert.equal((await f.service.list({ workspacePath: f.repo })).length, 1);
  await assert.rejects(
    f.service.prepare({
      ...request,
      taskId: "foreign",
      requestId: "foreign",
      workspaceIdentity: "remote:other",
    }),
  );
});

test("enabling retention enforces the new limit while preserving the newest binding", async (t) => {
  const f = await fixture(t);
  await f.service.updateManagementSettings({ autoDeleteEnabled: false });
  const first = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "first",
    requestId: "first",
  });
  await f.service.prepare({ workspacePath: f.repo, taskId: "second", requestId: "second" });
  await f.service.updateManagementSettings({ autoDeleteEnabled: true, retainedCount: 1 });
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "first" }))?.status,
    "archived",
  );
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "second" }))?.status,
    "ready",
  );
  assert.equal(
    (await f.service.restore({ bindingId: first.id, requestId: "restore" })).status,
    "ready",
  );
});
