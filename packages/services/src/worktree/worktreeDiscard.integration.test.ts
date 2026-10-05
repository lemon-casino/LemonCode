import assert from "node:assert/strict";
import { access, mkdir, readFile, symlink, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createCheckoutCoordinator, createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("archive collapses ignored dependency directories instead of exceeding the command output limit", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, ".gitignore"), "node_modules/\n");
  await mkdir(join(binding.checkoutPath, "node_modules", "fixture-package"), { recursive: true });
  await writeFile(
    join(binding.checkoutPath, "node_modules", "fixture-package", "index.js"),
    "ignored\n",
  );
  await writeFile(join(binding.checkoutPath, "file.txt"), "staged\n");
  await f.command(binding.checkoutPath, "add", "file.txt");
  await writeFile(join(binding.checkoutPath, "file.txt"), "unstaged\n");
  const index = await f.command(binding.checkoutPath, "write-tree");
  const service = createWorktreeService({
    ...f.options,
    git: {
      run: async (params) => {
        const result = await f.options.git.run(params);
        // 模拟生产环境 21 MB 的逐文件清单被截断；目录清单仍通过真实 Git 执行。
        return params.args.includes("--ignored") && !params.args.includes("--directory")
          ? { ...result, stderr: "", outputTruncated: true }
          : result;
      },
    },
  });
  const archived = await service.archive({
    bindingId: binding.id,
    requestId: "archive",
    acknowledgeIgnoredFiles: true,
  });
  assert.deepEqual(archived.snapshot?.ignoredPaths, ["node_modules/"]);
  const restored = await service.restore({ bindingId: binding.id, requestId: "restore" });
  assert.equal(await f.command(restored.checkoutPath, "write-tree"), index);
  assert.equal(await readFile(join(restored.checkoutPath, "file.txt"), "utf8"), "unstaged\n");
});

test("force discard removes unmerged work and ignored files without snapshotting or changing target", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "feature.txt"), "feature\n");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "unmerged");
  await writeFile(join(binding.checkoutPath, "file.txt"), "discard\n");
  await writeFile(join(binding.checkoutPath, "untracked.txt"), "discard\n");
  await writeFile(join(binding.checkoutPath, ".gitignore"), "cache/\n");
  await mkdir(join(binding.checkoutPath, "cache"));
  await writeFile(join(binding.checkoutPath, "cache", "data"), "discard\n");
  const target = await f.command(f.repo, "rev-parse", "HEAD");
  const request = {
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  const discarded = await f.service.archive(request);
  assert.equal(discarded.status, "deleted");
  assert.equal(discarded.snapshot, undefined);
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "branch", "--list", binding.branch), "");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), target);
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
  assert.equal((await f.service.archive(request)).status, "deleted");
  assert.equal((await f.service.list({ workspacePath: f.repo })).length, 0);
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "A" }))?.status,
    "deleted",
  );
  await assert.rejects(
    f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" }),
    /deleted/,
  );
  await assert.rejects(
    f.service.restore({ bindingId: binding.id, requestId: "restore" }),
    /deleted/,
  );
  const next = await f.service.prepare({ workspacePath: f.repo, taskId: "B", requestId: "B" });
  assert.equal(next.branch, binding.branch);
});

test("discard checks explicit scope, canonical path and live writer before any removal", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const request = {
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  await assert.rejects(
    f.service.archive({ ...request, discard: { ...request.discard, checkoutPath: f.repo } }),
    /confirmation/,
  );
  const coordinator = createCheckoutCoordinator({ ...f.options, waitMs: 30 });
  const lease = await coordinator.acquire({
    workspacePath: binding.checkoutPath,
    ownerId: "runtime",
    mode: "shared",
  });
  const service = createWorktreeService({ ...f.options, coordinator });
  await assert.rejects(service.archive(request), { code: "LCODE_CHECKOUT_BUSY" });
  await access(binding.checkoutPath);
  await coordinator.release(lease);
  await rename(binding.checkoutPath, `${binding.checkoutPath}-moved`);
  await symlink(f.repo, binding.checkoutPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.service.archive(request), /redirected/);
  await access(join(f.repo, "file.txt"));
});

test("discard crash retry releases registration and refuses a subsequently moved branch", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const request = {
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "discard.after-remove") throw new Error("lost delete response");
    },
  });
  await assert.rejects(service.archive(request), /lost delete response/);
  await writeFile(join(f.repo, "new.txt"), "new\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "new");
  const newHead = await f.command(f.repo, "rev-parse", "HEAD");
  await f.command(f.repo, "branch", "-f", binding.branch, newHead);
  await assert.rejects(f.service.archive(request), /branch changed/);
  assert.equal(await f.command(f.repo, "rev-parse", binding.branch), newHead);
  await f.command(f.repo, "branch", "-f", binding.branch, binding.baseCommit);
  assert.equal((await f.service.archive(request)).status, "deleted");
});

test("discard clears a missing checkout registration and will not touch a branch used in the original project", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const request = {
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  await rm(binding.checkoutPath, { recursive: true, force: true });
  assert.equal((await f.service.archive(request)).status, "deleted");
  assert.equal(
    (await f.command(f.repo, "worktree", "list", "--porcelain")).includes(
      binding.checkoutPath.replaceAll("\\", "/"),
    ),
    false,
  );
  const other = await f.service.prepare({ workspacePath: f.repo, taskId: "B", requestId: "B" });
  await f.service.archive({ bindingId: other.id, requestId: "archive" });
  await f.command(f.repo, "checkout", other.branch);
  await assert.rejects(
    f.service.archive({
      bindingId: other.id,
      requestId: "discard",
      discard: { branch: other.branch, checkoutPath: other.checkoutPath },
    }),
    /original project/,
  );
  await access(join(f.repo, "file.txt"));
  assert.equal(await f.command(f.repo, "branch", "--show-current"), other.branch);
});

test("archived work can be discarded and ordinary restore recreates a deleted task branch", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "untracked.txt"), "saved\n");
  const archived = await f.service.archive({ bindingId: binding.id, requestId: "archive" });
  await f.command(f.repo, "branch", "-d", binding.branch);
  const restored = await f.service.restore({ bindingId: binding.id, requestId: "restore" });
  assert.equal(restored.status, "ready");
  assert.equal(await readFile(join(binding.checkoutPath, "untracked.txt"), "utf8"), "saved\n");
  await f.service.archive({ bindingId: binding.id, requestId: "archive-again" });
  await f.service.archive({
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
  assert.equal(
    await f.command(
      f.repo,
      "for-each-ref",
      "--format=%(refname)",
      `refs/lcode/worktree-snapshots/${binding.id}`,
      `refs/lcode/worktree-indexes/${binding.id}`,
    ),
    "",
  );
  assert.ok(archived.snapshot);
});

test("discard cancels a reviewed integration and shared fork resolves the same tombstone", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await f.service.prepare({
    workspacePath: f.repo,
    taskId: "child",
    requestId: "fork",
    parentBinding: { bindingId: binding.id, bindingOwnerTaskId: "A", parentTaskId: "A" },
  });
  await writeFile(join(binding.checkoutPath, "feature.txt"), "feature\n");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "feature");
  const operation = await f.service.integrate({
    bindingId: binding.id,
    requestId: "merge",
    expectedSourceHead: await f.command(binding.checkoutPath, "rev-parse", "HEAD"),
    targetBranch: "main",
    validationCommands: [],
  });
  await f.service.archive({
    bindingId: binding.id,
    requestId: "discard",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  });
  assert.equal(
    (await f.service.getIntegration({ operationId: operation.id }))?.status,
    "cancelled",
  );
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "child" }))?.status,
    "deleted",
  );
  await assert.rejects(access(operation.checkoutPath), { code: "ENOENT" });
});
