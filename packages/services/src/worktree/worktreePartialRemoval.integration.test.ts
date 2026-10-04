import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

// 复现日志中的 Git 行为：已经解除登记并移除 .git，目录残留时仍返回失败。
function partiallyRemovingGit(
  f: Awaited<ReturnType<typeof fixture>>,
  after?: (path: string) => Promise<void>,
) {
  return {
    run: async (params: Parameters<typeof f.options.git.run>[0]) => {
      const result = await f.options.git.run(params);
      if (params.args[0] !== "worktree" || params.args[1] !== "remove" || result.exitCode !== 0)
        return result;
      const path = params.args.at(-1)!;
      await mkdir(join(path, "node_modules", "fixture"), { recursive: true });
      await writeFile(join(path, "node_modules", "fixture", "residual"), "residual\n");
      await after?.(path);
      return {
        ...result,
        exitCode: 1,
        stderr: `error: failed to delete '${path}': Directory not empty`,
      };
    },
  };
}

test("discard completes in one command when Git unregisters a checkout but leaves dependency directories", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const service = createWorktreeService({ ...f.options, git: partiallyRemovingGit(f) });
  const request = {
    bindingId: binding.id,
    requestId: "delete",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  assert.equal((await service.archive(request)).status, "deleted");
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "branch", "--list", binding.branch), "");
  assert.equal((await service.list({ workspacePath: f.repo })).length, 0);
  assert.equal((await service.archive(request)).status, "deleted");
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
});

test("a deleting journal resumes after restart and refuses a new Git marker in the residual directory", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const service = createWorktreeService({
    ...f.options,
    git: partiallyRemovingGit(f, (path) =>
      writeFile(join(path, ".git"), "replacement repository\n"),
    ),
  });
  const request = {
    bindingId: binding.id,
    requestId: "delete",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  await assert.rejects(service.archive(request), /Git marker/);
  assert.equal(
    (await service.getBinding({ workspacePath: f.repo, taskId: "A" }))?.status,
    "deleting",
  );
  await access(join(binding.checkoutPath, "node_modules", "fixture", "residual"));
  await rm(join(binding.checkoutPath, ".git"));
  const restarted = createWorktreeService(f.options);
  assert.equal((await restarted.archive({ ...request, requestId: "retry" })).status, "deleted");
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
});

test("archive clears partial Git removal and restores the saved working files", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "file.txt"), "saved change\n");
  const service = createWorktreeService({ ...f.options, git: partiallyRemovingGit(f) });
  const archived = await service.archive({ bindingId: binding.id, requestId: "archive" });
  assert.equal(archived.status, "archived");
  await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
  const restored = await service.restore({ bindingId: binding.id, requestId: "restore" });
  assert.equal(await readFile(join(restored.checkoutPath, "file.txt"), "utf8"), "saved change\n");
});

test("an interrupted archive resumes cleanup or can be explicitly deleted using its snapshot evidence", async (t) => {
  for (const discard of [false, true]) {
    const f = await fixture(t);
    const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
    const broken = createWorktreeService({
      ...f.options,
      git: partiallyRemovingGit(f, (path) => mkdir(join(path, ".git"))),
    });
    await assert.rejects(
      broken.archive({ bindingId: binding.id, requestId: "archive" }),
      /Git marker/,
    );
    await rm(join(binding.checkoutPath, ".git"), { recursive: true });
    const restarted = createWorktreeService(f.options);
    const result = await restarted.archive({
      bindingId: binding.id,
      requestId: "retry",
      ...(discard
        ? { discard: { branch: binding.branch, checkoutPath: binding.checkoutPath } }
        : {}),
    });
    assert.equal(result.status, discard ? "deleted" : "archived");
    await assert.rejects(access(binding.checkoutPath), { code: "ENOENT" });
    assert.equal(Boolean(await f.command(f.repo, "branch", "--list", binding.branch)), !discard);
  }
});

test("residual cleanup preserves redirected roots, linked contents and registered Git failures", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const request = {
    bindingId: binding.id,
    requestId: "delete",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  const rejected = createWorktreeService({
    ...f.options,
    git: {
      run: (params) =>
        params.args[0] === "worktree" && params.args[1] === "remove"
          ? Promise.resolve({ exitCode: 1, stderr: "fixture-remove-denied", stdout: "" })
          : f.options.git.run(params),
    },
  });
  await assert.rejects(rejected.archive(request), /fixture-remove-denied/);
  await access(join(binding.checkoutPath, "file.txt"));
  const redirected = createWorktreeService({
    ...f.options,
    git: partiallyRemovingGit(f, async (path) => {
      await rm(path, { recursive: true, force: true });
      await symlink(f.repo, path, process.platform === "win32" ? "junction" : "dir");
    }),
  });
  await assert.rejects(redirected.archive(request), /redirected/);
  await rm(binding.checkoutPath, { force: true });
  await mkdir(binding.checkoutPath);
  await symlink(
    f.repo,
    join(binding.checkoutPath, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal((await f.service.archive(request)).status, "deleted");
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "baseline\n");
});

test("an unregistered directory without cleanup evidence is preserved", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await f.command(f.repo, "worktree", "remove", "--force", binding.checkoutPath);
  await mkdir(binding.checkoutPath);
  await writeFile(join(binding.checkoutPath, "unknown"), "preserve\n");
  await assert.rejects(
    f.service.archive({
      bindingId: binding.id,
      requestId: "delete",
      discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
    }),
    /ownership is missing/,
  );
  assert.equal(await readFile(join(binding.checkoutPath, "unknown"), "utf8"), "preserve\n");
});

test("archive retry cleans an absent checkout registration and protects a changed task branch", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const interrupted = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "archive.after-snapshot") throw new Error("fixture-interrupted");
    },
  });
  await assert.rejects(
    interrupted.archive({ bindingId: binding.id, requestId: "archive" }),
    /fixture-interrupted/,
  );
  await f.command(binding.checkoutPath, "commit", "--allow-empty", "-m", "new work");
  await rm(binding.checkoutPath, { recursive: true, force: true });
  await assert.rejects(
    f.service.archive({ bindingId: binding.id, requestId: "retry" }),
    /branch changed/,
  );
  await f.command(f.repo, "update-ref", `refs/heads/${binding.branch}`, binding.baseCommit);
  assert.equal(
    (await f.service.archive({ bindingId: binding.id, requestId: "retry" })).status,
    "archived",
  );
  assert.equal(
    (await f.command(f.repo, "worktree", "list", "--porcelain")).includes(
      binding.checkoutPath.replaceAll("\\", "/"),
    ),
    false,
  );
});
