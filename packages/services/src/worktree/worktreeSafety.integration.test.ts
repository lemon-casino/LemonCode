import assert from "node:assert/strict";
import { access, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createCheckoutCoordinator, createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("checkout permits share canonical Git roots, retry idempotently and keep live owners", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.repo, "nested"));
  const first = createCheckoutCoordinator({ ...f.options, waitMs: 80 });
  const second = createCheckoutCoordinator({ ...f.options, waitMs: 80 });
  const lease = await first.acquire({ workspacePath: join(f.repo, "nested"), ownerId: "writer" });
  assert.equal(
    (await first.acquire({ workspacePath: f.repo, ownerId: "writer" })).token,
    lease.token,
  );
  await assert.rejects(second.acquire({ workspacePath: f.repo, ownerId: "publish" }), {
    code: "LCODE_CHECKOUT_BUSY",
  });
  await assert.rejects(first.release({ ...lease, ownerId: "wrong" }), /owner/);
  await first.release(lease);
  const next = await second.acquire({ workspacePath: f.repo, ownerId: "publish" });
  await first.release(lease);
  await second.release(next);
});

test("mapped same-repository folders are isolated and external writable folders rejected", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.repo, "nested"));
  await writeFile(join(f.repo, "nested", "file.txt"), "nested\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "nested");
  const binding = await f.service.prepare({
    workspacePath: join(f.repo, "nested"),
    sourceFolderPaths: [f.repo],
    taskId: "nested",
    requestId: "nested",
  });
  assert.equal(binding.workspacePath, join(binding.checkoutPath, "nested"));
  assert.deepEqual(binding.sourceFolderPaths, [binding.checkoutPath]);
  const capability = await f.service.getCapabilities({
    workspacePath: f.repo,
    sourceFolderPaths: [f.root],
  });
  assert.equal(capability.supported, false);
  await assert.rejects(
    f.service.prepare({
      workspacePath: f.repo,
      sourceFolderPaths: [f.root],
      taskId: "outside",
      requestId: "outside",
    }),
    /outside/,
  );
});

test("missing worktree never silently changes execution back to the original checkout", async (t) => {
  const f = await fixture(t);
  const request = { workspacePath: f.repo, taskId: "A", requestId: "A" };
  const binding = await f.service.prepare(request);
  await rename(binding.checkoutPath, `${binding.checkoutPath}-moved`);
  const missing = await f.service.getBinding({
    workspacePath: request.workspacePath,
    taskId: request.taskId,
  });
  assert.equal(missing?.status, "missing");
  assert.equal(missing?.workspacePath, binding.workspacePath);
  await assert.rejects(f.service.prepare(request));
});

test("snapshot failure preserves checkout; delete acknowledgement exposes ignored omissions", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, ".gitignore"), "cache.tmp\n");
  await writeFile(join(binding.checkoutPath, "cache.tmp"), "cache\n");
  await assert.rejects(
    f.service.archive({ bindingId: binding.id, requestId: "archive" }),
    /acknowledgement/,
  );
  assert.equal(await readFile(join(binding.checkoutPath, "cache.tmp"), "utf8"), "cache\n");
  const fault = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "archive.after-snapshot") throw new Error("snapshot interruption");
    },
  });
  await assert.rejects(
    fault.archive({ bindingId: binding.id, requestId: "archive", acknowledgeIgnoredFiles: true }),
    /snapshot interruption/,
  );
  await access(binding.checkoutPath);
  const archived = await f.service.archive({
    bindingId: binding.id,
    requestId: "archive",
    acknowledgeIgnoredFiles: true,
  });
  assert.deepEqual(archived.snapshot?.ignoredPaths, ["cache.tmp"]);
});

test("lost archive delete reply reconciles and restore refuses a occupied destination", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const fault = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "archive.after-remove") throw new Error("delete interruption");
    },
  });
  await assert.rejects(
    fault.archive({ bindingId: binding.id, requestId: "archive" }),
    /delete interruption/,
  );
  assert.equal(
    (await f.service.archive({ bindingId: binding.id, requestId: "archive" })).status,
    "archived",
  );
  await mkdir(binding.checkoutPath);
  await writeFile(join(binding.checkoutPath, "foreign.txt"), "preserve\n");
  await assert.rejects(
    f.service.restore({ bindingId: binding.id, requestId: "restore" }),
    /exists/,
  );
  assert.equal(await readFile(join(binding.checkoutPath, "foreign.txt"), "utf8"), "preserve\n");
});

test("redirected managed path cannot delete an external directory", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "precious.txt"), "preserve\n");
  await rename(binding.checkoutPath, `${binding.checkoutPath}-moved`);
  await symlink(outside, binding.checkoutPath, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    f.service.archive({ bindingId: binding.id, requestId: "archive" }),
    /redirected/,
  );
  assert.equal(await readFile(join(outside, "precious.txt"), "utf8"), "preserve\n");
});

test("archive detects external writes after the saved snapshot and preserves the new bytes", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "archive.after-snapshot")
        await writeFile(join(binding.checkoutPath, "external.txt"), "new external work\n");
    },
  });
  await assert.rejects(
    service.archive({ bindingId: binding.id, requestId: "archive" }),
    /changed after/,
  );
  assert.equal(
    await readFile(join(binding.checkoutPath, "external.txt"), "utf8"),
    "new external work\n",
  );
});

test("restore reconciles a lost response after materializing snapshot files", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "new.txt"), "untracked snapshot\n");
  await f.service.archive({ bindingId: binding.id, requestId: "archive" });
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "restore.after-files") throw new Error("lost restore response");
    },
  });
  await assert.rejects(
    service.restore({ bindingId: binding.id, requestId: "restore" }),
    /lost restore response/,
  );
  const restored = await f.service.restore({ bindingId: binding.id, requestId: "restore" });
  assert.equal(restored.status, "ready");
  assert.equal(
    await readFile(join(restored.checkoutPath, "new.txt"), "utf8"),
    "untracked snapshot\n",
  );
});

test("restore rechecks external writes after acquiring its permit and keeps those bytes", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "file.txt"), "snapshot\n");
  await f.service.archive({ bindingId: binding.id, requestId: "archive" });
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "restore.after-add")
        await writeFile(join(binding.checkoutPath, "file.txt"), "external\n");
    },
  });
  await assert.rejects(
    service.restore({ bindingId: binding.id, requestId: "restore" }),
    /contains changes/,
  );
  assert.equal(await readFile(join(binding.checkoutPath, "file.txt"), "utf8"), "external\n");
  await assert.rejects(
    f.service.restore({ bindingId: binding.id, requestId: "retry" }),
    /contains changes/,
  );
});

test("validation failure and stale target do not publish or rewrite source commits", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.checkoutPath, "feature.txt"), "feature\n");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "feature");
  const service = createWorktreeService({
    ...f.options,
    validate: async () => ({ exitCode: 1, output: "expected validation failure" }),
  });
  const sourceHead = await f.command(binding.checkoutPath, "rev-parse", "HEAD");
  const op = await service.integrate({
    bindingId: binding.id,
    requestId: "merge",
    expectedSourceHead: sourceHead,
    targetBranch: "main",
    validationCommands: ["project test"],
  });
  assert.equal(
    (
      await service.publishIntegration({
        operationId: op.id,
        approvedCandidateHead: op.candidateHead!,
      })
    ).status,
    "validation-failed",
  );
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), op.targetHead);
  assert.equal(await f.command(binding.checkoutPath, "rev-parse", "HEAD"), sourceHead);
  await writeFile(join(f.repo, "other.txt"), "external\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "external");
  await assert.rejects(
    service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /HEAD changed/,
  );
  assert.equal((await service.getIntegration({ operationId: op.id }))?.status, "failed");
});
