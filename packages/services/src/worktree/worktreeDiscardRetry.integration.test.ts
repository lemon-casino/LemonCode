import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("one archive(discard) call cleans the real tree and refs after long transient locking", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "create",
    setupCommands: [],
  });
  const originalHead = await f.command(f.repo, "rev-parse", "HEAD");
  let waited = 0;
  let stops = 0;
  let collections = 0;
  let purges = 0;
  let removals = 0;
  const service = createWorktreeService({
    ...f.options,
    stopWorktreeExecution: async () => {
      stops += 1;
    },
    collectDiscardSessions: async () => (++collections === 1 ? ["owner", "hidden"] : []),
    discardSessions: async (value, ids) => {
      purges += 1;
      assert.equal(value.deletion?.requestId, "delete-once");
      assert.deepEqual(ids, ["owner", "hidden"]);
    },
    discardRetryWait: async ({ delayMs, requestId }) => {
      assert.equal(requestId, "delete-once");
      const current = await service.getBinding({ workspacePath: f.repo, taskId: "owner" });
      assert.equal(current?.status, "deleting");
      assert.deepEqual(current?.deletion?.sessionIds, ["owner", "hidden"]);
      await assert.rejects(
        service.assertExecutionAdmission({ workspacePath: binding.checkoutPath }),
        /fenced/,
      );
      waited += delayMs;
    },
    removeDirectory: async (path) => {
      removals += 1;
      if (waited < 70_000) {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "locked-data.txt"), "fixture");
        throw Object.assign(new Error("fixture filesystem lock"), { code: "EBUSY" });
      }
      await rm(path, { recursive: true, force: true });
    },
  });
  const result = await service.archive({
    bindingId: binding.id,
    requestId: "delete-once",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
  assert.equal(result.status, "deleted");
  assert.ok(waited >= 70_000 && waited <= 120_000);
  assert.equal(stops, removals);
  assert.equal(collections, removals);
  assert.equal(purges, removals);
  assert.equal(result.deletion?.requestId, "delete-once");
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "branch", "--list", binding.branch), "");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), originalHead);
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
  assert.deepEqual(await service.list({ workspacePath: f.repo }), []);
});

test(
  "Windows cwd lock is retried inside one confirmation after its external holder exits",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    const binding = await f.service.prepare({
      workspacePath: f.repo,
      taskId: "owner",
      requestId: "create",
      setupCommands: [],
    });
    const holder = spawn(
      process.execPath,
      ["-e", "process.send('ready'); process.stdin.resume()"],
      {
        cwd: binding.checkoutPath,
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore", "ipc"],
      },
    );
    const exited = once(holder, "exit");
    const ready = once(holder, "message");
    t.after(async () => {
      if (holder.exitCode === null) holder.kill();
      await exited;
    });
    await ready;
    let retries = 0;
    const service = createWorktreeService({
      ...f.options,
      discardRetryWait: async () => {
        retries += 1;
        // 占用者由测试持有和释放；产品只重试受管删除，不按 cwd 杀未知外部进程。
        holder.kill();
        await exited;
      },
    });
    const result = await service.archive({
      bindingId: binding.id,
      requestId: "delete-once",
      discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
    });
    assert.equal(result.status, "deleted");
    assert.ok(retries > 0);
    await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
    assert.equal(await f.command(f.repo, "branch", "--list", binding.branch), "");
  },
);

test("a changed branch during backoff stops automatic deletion and preserves the new work", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "create",
    setupCommands: [],
  });
  let removals = 0;
  const service = createWorktreeService({
    ...f.options,
    discardRetryWait: async () => {
      await f.command(f.repo, "commit", "--allow-empty", "-m", "newer external work");
      await f.command(f.repo, "update-ref", `refs/heads/${binding.branch}`, "HEAD");
    },
    removeDirectory: async (path) => {
      removals += 1;
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "keep.txt"), "new work");
      throw Object.assign(new Error("filesystem locked"), { code: "EBUSY" });
    },
  });
  await assert.rejects(
    service.archive({
      bindingId: binding.id,
      requestId: "delete",
      discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
    }),
    /branch changed/,
  );
  assert.equal(removals, 1);
  assert.equal(await readFile(join(binding.checkoutPath, "keep.txt"), "utf8"), "new work");
  assert.notEqual(await f.command(f.repo, "branch", "--list", binding.branch), "");
  assert.equal(
    (await service.getBinding({ workspacePath: f.repo, taskId: "owner" }))?.status,
    "deleting",
  );
});
