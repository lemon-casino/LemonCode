import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";

import { fixture } from "./testFixture.js";

test("creation persists one binding and isolates files and indexes from dirty source", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "file.txt"), "original dirty\n");
  const request = { workspacePath: f.repo, taskId: "A", requestId: "create-A" };
  const a = await f.service.prepare(request);
  const b = await f.service.prepare({ ...request, taskId: "B", requestId: "create-B" });
  assert.equal(a.status, "ready");
  assert.equal((await f.service.prepare(request)).id, a.id);
  assert.equal(
    (
      await createWorktreeService(f.options).getBinding({
        workspacePath: request.workspacePath,
        taskId: request.taskId,
      })
    )?.workspacePath,
    a.workspacePath,
  );
  assert.equal(await readFile(join(a.workspacePath, "file.txt"), "utf8"), "baseline\n");
  await writeFile(join(a.workspacePath, "file.txt"), "A\n");
  await f.command(a.workspacePath, "add", "file.txt");
  assert.equal(await f.command(b.workspacePath, "diff", "--cached", "--name-only"), "");
  assert.equal(await f.command(f.repo, "diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "original dirty\n");
});

test("integration freezes source, validates elsewhere and refuses dirty or stale target", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(a.workspacePath, "feature.txt"), "feature\n");
  await f.command(a.workspacePath, "add", ".");
  await f.command(a.workspacePath, "commit", "-m", "feature");
  const sourceHead = await f.command(a.workspacePath, "rev-parse", "HEAD");
  const operation = await f.service.integrate({
    bindingId: a.id,
    requestId: "merge",
    expectedSourceHead: sourceHead,
    targetBranch: "main",
  });
  assert.equal(operation.status, "awaiting-review");
  await writeFile(join(f.repo, "file.txt"), "dirty\n");
  await assert.rejects(
    f.service.publishIntegration({
      operationId: operation.id,
      approvedCandidateHead: operation.candidateHead!,
    }),
    /dirty|uncommitted/i,
  );
  await writeFile(join(f.repo, "file.txt"), "baseline\n");
  const result = await f.service.publishIntegration({
    operationId: operation.id,
    approvedCandidateHead: operation.candidateHead!,
  });
  assert.equal(result.status, "published");
  assert.equal(await readFile(join(f.repo, "feature.txt"), "utf8"), "feature\n");
  assert.equal(
    (
      await f.service.publishIntegration({
        operationId: operation.id,
        approvedCandidateHead: operation.candidateHead!,
      })
    ).status,
    "published",
  );
});

test("conflicts remain in integration checkout and manual resolution requires review", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(a.workspacePath, "file.txt"), "task change\n");
  await f.command(a.workspacePath, "commit", "-am", "task");
  await writeFile(join(f.repo, "file.txt"), "target change\n");
  await f.command(f.repo, "commit", "-am", "target");
  const operation = await f.service.integrate({
    bindingId: a.id,
    requestId: "merge",
    expectedSourceHead: await f.command(a.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
  });
  assert.equal(operation.status, "conflicted");
  assert.deepEqual(operation.conflictPaths, ["file.txt"]);
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "target change\n");
  await writeFile(join(operation.checkoutPath, "file.txt"), "resolved both\n");
  await f.command(operation.checkoutPath, "add", "file.txt");
  const resolved = await f.service.continueIntegration({ operationId: operation.id });
  assert.equal(resolved.status, "awaiting-review");
  assert.ok(resolved.candidateHead);
  assert.equal(
    (
      await f.service.publishIntegration({
        operationId: operation.id,
        approvedCandidateHead: resolved.candidateHead!,
      })
    ).status,
    "published",
  );
});

test("archive and restore preserve staged, unstaged and untracked content", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(a.workspacePath, "file.txt"), "staged\n");
  await f.command(a.workspacePath, "add", "file.txt");
  await writeFile(join(a.workspacePath, "file.txt"), "working\n");
  await writeFile(join(a.workspacePath, "new.txt"), "untracked\n");
  const archived = await f.service.archive({ bindingId: a.id, requestId: "archive" });
  assert.equal(archived.status, "archived");
  const restored = await createWorktreeService(f.options).restore({
    bindingId: a.id,
    requestId: "restore",
  });
  assert.equal(restored.status, "ready");
  assert.equal(await readFile(join(restored.workspacePath, "file.txt"), "utf8"), "working\n");
  assert.equal(await f.command(restored.workspacePath, "show", ":file.txt"), "staged");
  assert.equal(
    await f.command(restored.workspacePath, "ls-files", "--others", "--exclude-standard"),
    "new.txt",
  );
});

test("creation failure after native registration recovers without a second checkout", async (t) => {
  const f = await fixture(t);
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "prepare.after-add") throw new Error("injected interruption");
    },
  });
  const request = { workspacePath: f.repo, taskId: "A", requestId: "A" };
  await assert.rejects(service.prepare(request), /injected interruption/);
  const recovered = await f.service.prepare(request);
  assert.equal(recovered.status, "ready");
  assert.equal((await f.service.list({ workspacePath: f.repo })).length, 1);
});

test("lost publication response reconciles without replaying commits", async (t) => {
  const f = await fixture(t);
  const a = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(a.workspacePath, "new.txt"), "new\n");
  await f.command(a.workspacePath, "add", ".");
  await f.command(a.workspacePath, "commit", "-m", "new");
  const operation = await f.service.integrate({
    bindingId: a.id,
    requestId: "merge",
    expectedSourceHead: await f.command(a.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
  });
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "publish.after-merge") throw new Error("lost response");
    },
  });
  const request = { operationId: operation.id, approvedCandidateHead: operation.candidateHead! };
  await assert.rejects(service.publishIntegration(request), /lost response/);
  const head = await f.command(f.repo, "rev-parse", "HEAD");
  assert.equal((await f.service.publishIntegration(request)).status, "published");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), head);
});
