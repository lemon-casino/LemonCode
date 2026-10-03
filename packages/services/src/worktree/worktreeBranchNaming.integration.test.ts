import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("Chinese task branches are valid native Git refs with numeric duplicate suffixes", async (t) => {
  const f = await fixture(t);
  const prepare = (taskId: string) =>
    f.service.prepare({
      workspacePath: f.repo,
      taskId,
      requestId: taskId,
      taskName: "修复模型切换",
      setupCommands: [],
    });
  const first = await prepare("A");
  const second = await prepare("B");
  assert.equal(first.branch, "lcode/task-修复模型切换");
  assert.equal(second.branch, "lcode/task-修复模型切换-2");
  assert.equal(await f.command(first.checkoutPath, "branch", "--show-current"), first.branch);
  assert.equal(await f.command(f.repo, "check-ref-format", "--branch", first.branch), first.branch);
  assert.equal(first.checkoutPath, join(f.options.dataDir, "checkouts", first.id));
  await f.command(f.repo, "branch", "lcode/task-修复模型切换-3");
  assert.equal((await prepare("C")).branch, "lcode/task-修复模型切换-4");
  assert.equal((await prepare("A")).branch, first.branch);
});

test("independent service instances reserve duplicate task names before checkout creation", async (t) => {
  const f = await fixture(t);
  const services = Array.from({ length: 3 }, () => createWorktreeService(f.options));
  const bindings = await Promise.all(
    services.map((service, index) =>
      service.prepare({
        workspacePath: f.repo,
        taskId: `task-${index}`,
        requestId: `request-${index}`,
        taskName: "优化设置",
        setupCommands: [],
      }),
    ),
  );
  assert.deepEqual(bindings.map((binding) => binding.branch).sort(), [
    "lcode/task-优化设置",
    "lcode/task-优化设置-2",
    "lcode/task-优化设置-3",
  ]);
});

test("failed preparation reserves its name and retries retain it after restart", async (t) => {
  const f = await fixture(t);
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "prepare.after-add") throw new Error("fixture interruption");
    },
  });
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    taskName: "修复会话",
    setupCommands: [],
  };
  await assert.rejects(service.prepare(request), /fixture interruption/);
  const failed = await service.getBinding({ workspacePath: f.repo, taskId: "A" });
  assert.equal(failed?.branch, "lcode/task-修复会话");
  assert.equal(
    (await f.service.prepare({ ...request, taskId: "B", requestId: "B" })).branch,
    "lcode/task-修复会话-2",
  );
  assert.equal(
    (await f.service.prepare({ ...request, taskName: "任务标题改过" })).branch,
    failed?.branch,
  );
});

test("archive and restore retain Chinese names and old random branch bindings remain compatible", async (t) => {
  const f = await fixture(t);
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    taskName: "恢复项目",
    setupCommands: [],
  };
  const binding = await f.service.prepare(request);
  await f.service.archive({
    bindingId: binding.id,
    requestId: "archive",
    acknowledgeIgnoredFiles: true,
  });
  assert.equal(
    (await f.service.restore({ bindingId: binding.id, requestId: "restore" })).branch,
    binding.branch,
  );
  const legacyBranch = `lcode/task-${binding.id}`;
  await f.command(binding.checkoutPath, "branch", "-m", legacyBranch);
  const file = join(f.options.dataDir, "bindings", `${binding.id}.json`);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.branch = legacyBranch;
  await writeFile(file, JSON.stringify(record));
  assert.equal((await createWorktreeService(f.options).prepare(request)).branch, legacyBranch);
});

test("untitled worktrees use a Chinese default without a random branch suffix", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    setupCommands: [],
  });
  assert.equal(binding.branch, "lcode/task-新会话");
});
