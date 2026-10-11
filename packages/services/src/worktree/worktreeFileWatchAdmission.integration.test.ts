import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./testFixture.js";
import { createPublicWorktreeService, createWorktreeService } from "./node.js";
import { createWorktreeStore } from "./adapters/store.js";
import { createFileWatcherService } from "../fileWatcher/fileWatcherService.js";

test("deletion closes real watchers before Git removal and fences new watches across Host restart", async (t) => {
  const f = await fixture(t);
  const worktrees = createWorktreeService({
    ...f.options,
    stopWorktreeExecution: async (binding) => {
      await watchers.stopPathAndWait(binding.checkoutPath);
      const restarted = createWorktreeService(f.options);
      await assert.rejects(restarted.assertFileWatchAdmission(binding.checkoutPath), /fenced/);
      await assert.rejects(watchers.watch({ path: binding.checkoutPath }), /fenced/);
      await assert.rejects(watchers.watch({ path: child }), /fenced/);
      stopped = true;
    },
    git: {
      run: async (params) => {
        if (params.args[0] === "worktree" && params.args[1] === "remove")
          assert.ok(stopped, "all native close receipts must precede Git removal");
        return f.options.git.run(params);
      },
    },
  });
  const watchers = createFileWatcherService({
    assertWatchAllowed: (path) => worktrees.assertFileWatchAdmission(path),
  });
  t.after(() => watchers.disposeAll());
  const binding = await worktrees.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "prepare",
    setupCommands: [],
  });
  const child = join(binding.checkoutPath, "child");
  await mkdir(child);
  await watchers.watch({ path: binding.checkoutPath });
  await watchers.watch({ path: child });
  let stopped = false;
  const deleted = await worktrees.archive({
    bindingId: binding.id,
    requestId: "delete",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
  assert.equal(deleted.status, "deleted");
  await assert.rejects(worktrees.assertFileWatchAdmission(child), /fenced/);
  await worktrees.assertFileWatchAdmission(f.repo);
  assert.equal("assertFileWatchAdmission" in createPublicWorktreeService(worktrees), false);
});

test("physical watcher admission protects custom remote checkouts without changing execution identity matching", async (t) => {
  const f = await fixture(t);
  await f.service.updateManagementSettings({
    rootLocation: "custom",
    rootDirectory: join(f.root, "custom"),
  });
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "prepare",
    setupCommands: [],
  });
  const store = createWorktreeStore(f.options.dataDir);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const link = join(binding.checkoutPath, "linked");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  for (const status of ["archiving", "archived", "deleting", "deleted"] as const) {
    await store.saveBinding({ ...binding, workspaceIdentity: "remote-fixture", status });
    await assert.rejects(f.service.assertFileWatchAdmission(binding.checkoutPath), /fenced/);
    await f.service.assertExecutionAdmission({ workspacePath: binding.checkoutPath });
    await f.service.assertFileWatchAdmission(link);
    await f.service.assertFileWatchAdmission(`${binding.checkoutPath}-other`);
  }
  await store.saveBinding(binding);
  await f.service.assertFileWatchAdmission(binding.checkoutPath);
  await f.service.archive({
    bindingId: binding.id,
    requestId: "archive",
    acknowledgeIgnoredFiles: true,
  });
  await assert.rejects(f.service.assertFileWatchAdmission(binding.checkoutPath), /fenced/);
  await f.service.restore({ bindingId: binding.id, requestId: "restore" });
  await f.service.assertFileWatchAdmission(binding.checkoutPath);
});
