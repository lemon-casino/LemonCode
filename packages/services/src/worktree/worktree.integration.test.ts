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
  await writeFile(join(a.workspacePath, "file.txt"), "feature edit\n");
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
    /local changes|overwritten/i,
  );
  await writeFile(join(f.repo, "file.txt"), "baseline\n");
  const result = await f.service.publishIntegration({
    operationId: operation.id,
    approvedCandidateHead: operation.candidateHead!,
    skipValidation: true,
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

test("publication keeps unrelated tracked and untracked target edits intact", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "B", requestId: "B" });
  await writeFile(join(binding.workspacePath, "feature.txt"), "feature\n");
  await f.command(binding.workspacePath, "add", "feature.txt");
  await f.command(binding.workspacePath, "commit", "-m", "feature");
  const op = await f.service.integrate({
    bindingId: binding.id,
    requestId: "merge-B",
    expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
  });
  await writeFile(join(f.repo, "file.txt"), "unrelated working edit\n");
  await writeFile(join(f.repo, "local draft.txt"), "untracked draft\n");
  const beforeStatus = await f.command(f.repo, "status", "--porcelain");
  const beforeIndex = await f.command(f.repo, "write-tree");
  const result = await f.service.publishIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead!,
    skipValidation: true,
  });
  assert.equal(result.status, "published");
  assert.equal(await f.command(f.repo, "status", "--porcelain"), beforeStatus);
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "unrelated working edit\n");
  assert.equal(await readFile(join(f.repo, "local draft.txt"), "utf8"), "untracked draft\n");
  assert.equal(await readFile(join(f.repo, "feature.txt"), "utf8"), "feature\n");
  assert.notEqual(await f.command(f.repo, "write-tree"), beforeIndex);
  assert.equal(await f.command(f.repo, "diff", "--cached", "--name-only"), "");
});

test("publication refuses an untracked overwrite without changing target HEAD or index", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "C", requestId: "C" });
  await writeFile(join(binding.workspacePath, "collision.txt"), "source\n");
  await f.command(binding.workspacePath, "add", ".");
  await f.command(binding.workspacePath, "commit", "-m", "collision");
  const op = await f.service.integrate({
    bindingId: binding.id,
    requestId: "merge-C",
    expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
  });
  await writeFile(join(f.repo, "collision.txt"), "keep local\n");
  const before = await f.command(f.repo, "rev-parse", "HEAD");
  const index = await f.command(f.repo, "write-tree");
  await assert.rejects(
    f.service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /local changes|overwritten/i,
  );
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), before);
  assert.equal(await f.command(f.repo, "write-tree"), index);
  assert.equal(await readFile(join(f.repo, "collision.txt"), "utf8"), "keep local\n");
});

test("publication rechecks overwrite risks introduced during candidate validation", async (t) => {
  const f = await fixture(t);
  const service = createWorktreeService({
    ...f.options,
    validate: async () => {
      await writeFile(join(f.repo, "file.txt"), "edit during validation\n");
      return { exitCode: 0, output: "validated" };
    },
  });
  const binding = await service.prepare({ workspacePath: f.repo, taskId: "D", requestId: "D" });
  await writeFile(join(binding.workspacePath, "file.txt"), "source edit\n");
  await f.command(binding.workspacePath, "commit", "-am", "source");
  const op = await service.integrate({
    bindingId: binding.id,
    requestId: "merge-D",
    expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
    validationCommands: ["test-command"],
  });
  const before = await f.command(f.repo, "rev-parse", "HEAD");
  const index = await f.command(f.repo, "write-tree");
  await assert.rejects(
    service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /local changes|overwritten/i,
  );
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), before);
  assert.equal(await f.command(f.repo, "write-tree"), index);
  assert.equal(await readFile(join(f.repo, "file.txt"), "utf8"), "edit during validation\n");
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
        skipValidation: true,
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
  const request = { operationId: operation.id, approvedCandidateHead: operation.candidateHead!, skipValidation: true };
  await assert.rejects(service.publishIntegration(request), /lost response/);
  const head = await f.command(f.repo, "rev-parse", "HEAD");
  assert.equal((await f.service.publishIntegration(request)).status, "published");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), head);
});
