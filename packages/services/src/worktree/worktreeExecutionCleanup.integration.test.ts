import assert from "node:assert/strict";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LCodeAgentProcessManager } from "../lcode-agent/lcodeAgentProcessManager.js";
import { createFileWatcherService } from "../fileWatcher/fileWatcherService.js";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("local checkout deletion waits for owned subdirectory process and watcher exits before removal", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "create",
    environmentPolicy: "local",
  });
  const child = join(binding.checkoutPath, "packages", "server");
  await mkdir(child, { recursive: true });
  let exited = false;
  const manager = new LCodeAgentProcessManager({
    commandResolver: () => ({ command: process.execPath, args: ["-e", "process.stdin.resume()"] }),
    onProcessCleanupCompleted: async () => {
      exited = true;
    },
  });
  const watchers = createFileWatcherService();
  t.after(async () => {
    watchers.disposeAll();
    await manager.disposeAllAndWait();
  });
  await manager.getClient({ workspacePath: child });
  await watchers.watch({ path: child });
  let stopped = false;
  const service = createWorktreeService({
    ...f.options,
    stopWorktreeExecution: async (value) => {
      assert.equal(value.id, binding.id);
      await manager.disposeWorkspace({ workspacePath: child });
      await watchers.stopPathAndWait(value.checkoutPath);
      stopped = true;
    },
    removeDirectory: async (path) => {
      assert.ok(exited && stopped, "removal needs actual owner receipts");
      await rm(path, { recursive: true, force: true });
    },
  });
  assert.equal(
    (
      await service.archive({
        bindingId: binding.id,
        requestId: "delete",
        discard: {
          branch: binding.branch,
          checkoutPath: binding.checkoutPath,
        },
      })
    ).status,
    "deleted",
  );
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
});

test("EBUSY preserves stable deletion facts and retry stops owners again before clearing the residual tree", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "create",
  });
  let stops = 0;
  let collects = 0;
  let removals = 0;
  const options = {
    ...f.options,
    stopWorktreeExecution: async () => {
      stops++;
    },
    collectDiscardSessions: async () => {
      collects++;
      return ["owner", "hidden"];
    },
    discardSessions: async (_binding: unknown, ids: string[]) =>
      assert.deepEqual(ids, ["owner", "hidden"]),
    removeDirectory: async (path: string) => {
      if (++removals === 1) {
        // Git 已解除登记，模拟历史 EBUSY 时留下的物理残留，不能失去原 journal 证据。
        await mkdir(path, { recursive: true });
        throw Object.assign(new Error("EBUSY: fixture directory in use"), { code: "EBUSY" });
      }
      await rm(path, { recursive: true, force: true });
    },
  };
  const request = {
    bindingId: binding.id,
    requestId: "delete-original",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  assert.equal(
    (
      await createWorktreeService({
        ...options,
        transientRetryWait: async ({ requestId }) => {
          assert.equal(requestId, request.requestId);
          const failed = await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" });
          assert.equal(failed?.status, "deleting");
          assert.equal(failed?.deletion?.requestId, request.requestId);
          assert.deepEqual(failed?.deletion?.sessionIds, ["owner", "hidden"]);
        },
      }).archive(request)
    ).status,
    "deleted",
  );
  assert.equal(stops, 2);
  assert.equal(collects, 2);
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
});
