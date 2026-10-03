import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

test("preparation snapshots are durable and cancellation prevents ready", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = createWorktreeService({
    ...f.options,
    validate: async () => {
      entered();
      await gate;
      return { exitCode: 0, output: "dependency step finished" };
    },
  });
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "request-A",
    setupCommands: ["fixture"],
  };
  const preparing = service.prepare(request);
  const rejected = assert.rejects(preparing, /cancelled/i);
  await started;
  const snapshot = await f.service.getBinding({
    workspacePath: f.repo,
    requestId: request.requestId,
  });
  assert.equal(snapshot?.preparation?.stage, "environment");
  assert.equal(snapshot?.status, "preparing");
  await f.service.prepare({ ...request, cancel: true });
  assert.equal(
    (await service.getBinding({ workspacePath: f.repo, taskId: "A" }))?.preparation
      ?.cancelRequested,
    true,
  );
  finish();
  await rejected;
  const cancelled = await createWorktreeService(f.options).getBinding({
    workspacePath: f.repo,
    taskId: "A",
  });
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.preparation?.stage, "cancelled");
  await assert.rejects(service.prepare(request), /cancelled/i);
  await service.archive({ bindingId: cancelled!.id, requestId: "archive-cancelled" });
  await service.restore({ bindingId: cancelled!.id, requestId: "restore-cancelled" });
  await assert.rejects(service.prepare(request), /cancelled/i);
});

test("default setup discovers a locked package manager; explicit empty setup overrides discovery", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, "package.json"),
    JSON.stringify({ packageManager: "pnpm@10.33.2", dependencies: { fixture: "1.0.0" } }),
  );
  await writeFile(join(f.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "manifest");
  const calls: string[] = [];
  const service = createWorktreeService({
    ...f.options,
    validate: async (_cwd, command) => {
      calls.push(command);
      return { exitCode: 0, output: "installed" };
    },
  });
  const binding = await service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  assert.deepEqual(calls, ["pnpm install --frozen-lockfile"]);
  assert.equal(binding.preparation?.environmentSource, "detected");
  assert.equal(binding.preparation?.stage, "ready");
  await service.prepare({ workspacePath: f.repo, taskId: "B", requestId: "B", setupCommands: [] });
  assert.equal(calls.length, 1);
});

test("new worktree fork preserves working files and index without changing its source", async (t) => {
  const f = await fixture(t);
  const source = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "source",
    requestId: "source",
  });
  await writeFile(join(source.checkoutPath, "committed.txt"), "parent commit\n");
  await f.command(source.checkoutPath, "add", ".");
  await f.command(source.checkoutPath, "commit", "-m", "parent advances");
  await writeFile(join(source.checkoutPath, "file.txt"), "staged\n");
  await f.command(source.checkoutPath, "add", "file.txt");
  await writeFile(join(source.checkoutPath, "file.txt"), "working\n");
  await writeFile(join(source.checkoutPath, "new.txt"), "untracked\n");
  const before = await f.command(source.checkoutPath, "status", "--porcelain");
  const head = await f.command(source.checkoutPath, "rev-parse", "HEAD");
  const index = await f.command(source.checkoutPath, "write-tree");
  const request = {
    workspacePath: f.repo,
    taskId: "fork",
    requestId: "fork",
    forkSource: { workspacePath: source.workspacePath },
  };
  const fork = await f.service.prepare(request);
  assert.notEqual(fork.checkoutPath, source.checkoutPath);
  assert.equal(fork.baseCommit, head);
  assert.equal(await f.command(fork.checkoutPath, "rev-parse", "HEAD"), head);
  assert.equal(await readFile(join(fork.checkoutPath, "committed.txt"), "utf8"), "parent commit\n");
  assert.equal(await readFile(join(fork.checkoutPath, "file.txt"), "utf8"), "working\n");
  assert.equal(await readFile(join(fork.checkoutPath, "new.txt"), "utf8"), "untracked\n");
  assert.equal(await f.command(fork.checkoutPath, "show", ":file.txt"), "staged");
  assert.equal(await f.command(fork.checkoutPath, "status", "--porcelain"), before);
  assert.equal(await f.command(source.checkoutPath, "status", "--porcelain"), before);
  assert.equal(await f.command(source.checkoutPath, "rev-parse", "HEAD"), head);
  assert.equal(await f.command(source.checkoutPath, "write-tree"), index);
  assert.equal((await f.service.prepare(request)).id, fork.id);
  await unlink(join(fork.checkoutPath, "file.txt"));
  assert.equal(await readFile(join(source.checkoutPath, "file.txt"), "utf8"), "working\n");
});

test("new worktree fork refuses a source with an active writer", async (t) => {
  const f = await fixture(t);
  const lease = await f.service.acquireCheckout({
    workspacePath: f.repo,
    ownerId: "running-parent",
  });
  try {
    await assert.rejects(
      f.service.prepare({
        workspacePath: f.repo,
        taskId: "fork",
        requestId: "fork",
        forkSource: { workspacePath: f.repo },
      }),
      /busy/,
    );
  } finally {
    await f.service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  }
});

test("fork setup retry preserves files already restored and records the failing step", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "file.txt"), "parent working\n");
  let fail = true;
  const service = createWorktreeService({
    ...f.options,
    validate: async (cwd) => {
      if (fail) {
        await writeFile(join(cwd, "file.txt"), "setup working\n");
        return { exitCode: 1, output: "failed" };
      }
      return { exitCode: 0, output: "ready" };
    },
  });
  const request = {
    workspacePath: f.repo,
    taskId: "fork",
    requestId: "fork",
    forkSource: { workspacePath: f.repo },
    setupCommands: ["fixture"],
  };
  await assert.rejects(service.prepare(request), /failed/);
  const failed = await service.getBinding({ workspacePath: f.repo, taskId: "fork" });
  assert.equal(failed?.preparation?.activeStep, "environment");
  assert.equal(failed?.forkFilesRestored, true);
  fail = false;
  const ready = await service.prepare({ ...request, retrySetup: true });
  assert.equal(await readFile(join(ready.checkoutPath, "file.txt"), "utf8"), "setup working\n");
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "parent working\n");
});

test("integration discovers checks from its candidate and blocks publication until validation passes", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  let failValidation = true;
  const service = createWorktreeService({
    ...f.options,
    validate: async (_cwd, command) => {
      calls.push(command);
      return { exitCode: failValidation ? 1 : 0, output: "checked" };
    },
  });
  const binding = await service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(
    join(binding.checkoutPath, "package.json"),
    JSON.stringify({ packageManager: "npm@11.0.0", scripts: { lint: "fixture" } }),
  );
  await writeFile(join(binding.checkoutPath, "package-lock.json"), "{}");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "candidate manifest");
  const sourceHead = await f.command(binding.checkoutPath, "rev-parse", "HEAD");
  const operation = await service.integrate({
    bindingId: binding.id,
    requestId: "integration",
    expectedSourceHead: sourceHead,
    targetBranch: "main",
  });
  assert.equal(operation.status, "awaiting-review");
  assert.equal(operation.validationSource, "detected");
  assert.deepEqual(operation.validationCommands, ["npm ci", "npm run lint"]);
  const blocked = await service.publishIntegration({
    operationId: operation.id,
    approvedCandidateHead: operation.candidateHead!,
  });
  assert.equal(blocked.status, "validation-failed");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), operation.targetHead);
  failValidation = false;
  const ready = await service.continueIntegration({
    operationId: operation.id,
    approvedCandidateHead: operation.candidateHead,
  });
  assert.equal(ready.status, "ready");
  assert.deepEqual(calls, ["npm ci", "npm ci", "npm run lint"]);
});

test("native setup streams bounded UTF-8 logs and late cancellation cannot undo ready", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, "fixture.cjs"),
    "process.stdout.write('准备依赖\\n' + 'x'.repeat(72000) + '\\nfinished-dependencies\\n');",
  );
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "setup fixture");
  const request = {
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    setupCommands: ["node fixture.cjs"],
  };
  const ready = await f.service.prepare(request);
  assert.equal(ready.preparation?.stage, "ready");
  assert.equal(ready.preparation?.logTruncated, true);
  assert.ok(ready.preparation!.log.length <= 65536);
  assert.match(ready.preparation!.log, /finished-dependencies/);
  assert.equal((await f.service.prepare({ ...request, cancel: true })).status, "ready");
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, requestId: "A" }))?.preparation
      ?.cancelRequested,
    false,
  );
});
