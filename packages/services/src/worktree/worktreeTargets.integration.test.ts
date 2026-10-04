import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fixture } from "./testFixture.js";
import { createWorktreeService, createCheckoutCoordinator } from "./node.js";

async function task(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await f.command(f.repo, "branch", "other");
  const binding = await f.service.prepare({
    workspacePath: f.repo,
    taskId: "A",
    requestId: "A",
    setupCommands: [],
  });
  await writeFile(join(binding.checkoutPath, "feature.txt"), "feature\n");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "feature");
  const request = {
    bindingId: binding.id,
    requestId: "merge",
    expectedSourceHead: await f.command(binding.checkoutPath, "rev-parse", "HEAD"),
    targetBranch: "other",
    validationCommands: [],
  };
  return { ...f, binding, request };
}

test("unchecked target merges without switching the original directory and removes temporary checkout", async (t) => {
  const f = await task(t);
  const originalHead = await f.command(f.repo, "rev-parse", "HEAD");
  const op = await f.service.integrate(f.request);
  assert.equal(op.targetTemporary, true);
  assert.equal(await f.command(f.repo, "branch", "--show-current"), "main");
  assert.equal(await f.command(op.targetPath, "branch", "--show-current"), "");
  await f.service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  const result = await f.service.publishIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead!,
  });
  assert.equal(result.status, "published");
  assert.equal(await f.command(f.repo, "branch", "--show-current"), "main");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), originalHead);
  assert.equal(await f.command(f.repo, "rev-parse", "other"), op.candidateHead);
  assert.equal(
    await f.command(f.binding.checkoutPath, "rev-parse", "HEAD"),
    f.request.expectedSourceHead,
  );
  await assert.rejects(access(op.targetPath));
  assert.equal(
    (
      await f.service.publishIntegration({
        operationId: op.id,
        approvedCandidateHead: op.candidateHead!,
      })
    ).status,
    "published",
  );
});

test("checked-out target resolves to its actual worktree and preserves unrelated files", async (t) => {
  const f = await task(t);
  const target = join(f.root, "target");
  await f.command(f.repo, "worktree", "add", target, "other");
  await writeFile(join(target, "notes.txt"), "keep\n");
  const op = await f.service.integrate(f.request);
  assert.equal(op.targetTemporary, undefined);
  assert.equal(
    op.targetPath.replaceAll("\\", "/").toLowerCase(),
    target.replaceAll("\\", "/").toLowerCase(),
  );
  await f.service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  assert.equal(
    (
      await f.service.publishIntegration({
        operationId: op.id,
        approvedCandidateHead: op.candidateHead!,
      })
    ).status,
    "published",
  );
  await access(join(target, "notes.txt"));
  assert.equal(await f.command(f.repo, "branch", "--show-current"), "main");
});

test("changed target ref and self target fail without updating either branch", async (t) => {
  const f = await task(t);
  await assert.rejects(
    f.service.integrate({ ...f.request, targetBranch: f.binding.branch }),
    /source.*target|itself/i,
  );
  const op = await f.service.integrate(f.request);
  await f.service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  await f.command(f.repo, "update-ref", "refs/heads/other", f.request.expectedSourceHead);
  await assert.rejects(
    f.service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /Target.*changed/,
  );
  assert.equal(await f.command(f.repo, "rev-parse", "other"), f.request.expectedSourceHead);
  assert.equal(await f.command(f.repo, "branch", "--show-current"), "main");
});

test("lost merge response reconciles the exact target and does not remerge", async (t) => {
  const f = await task(t);
  let fail = true;
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "publish.after-merge" && fail) {
        fail = false;
        throw new Error("lost response");
      }
    },
  });
  const op = await service.integrate(f.request);
  await service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  const params = { operationId: op.id, approvedCandidateHead: op.candidateHead! };
  await assert.rejects(service.publishIntegration(params), /lost response/);
  assert.equal(await f.command(f.repo, "rev-parse", "other"), op.candidateHead);
  assert.equal(
    (await createWorktreeService(f.options).publishIntegration(params)).status,
    "published",
  );
  await assert.rejects(access(op.targetPath));
  assert.equal(await f.command(f.repo, "branch", "--show-current"), "main");
});

test("actual target writer lease blocks publication; cancellation cleans only the temporary target", async (t) => {
  const f = await task(t);
  const op = await f.service.integrate(f.request);
  await f.service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  const lease = await f.service.acquireCheckout({
    workspacePath: op.targetPath,
    ownerId: "writer",
  });
  const service = createWorktreeService({
    ...f.options,
    coordinator: createCheckoutCoordinator({ ...f.options, waitMs: 80 }),
  });
  await assert.rejects(
    service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    { code: "LCODE_CHECKOUT_BUSY" },
  );
  assert.equal(await f.command(f.repo, "rev-parse", "other"), op.targetHead);
  await f.service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  assert.equal(
    (await f.service.continueIntegration({ operationId: op.id, cancel: true })).status,
    "cancelled",
  );
  await assert.rejects(access(op.targetPath));
  await access(op.checkoutPath);
});

test("recovery never treats a detached candidate checkout as a published target ref", async (t) => {
  const f = await task(t);
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "publish.before-merge") throw new Error("interrupted before merge");
    },
  });
  const op = await service.integrate(f.request);
  await service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  const params = { operationId: op.id, approvedCandidateHead: op.candidateHead! };
  await assert.rejects(service.publishIntegration(params), /interrupted before merge/);
  await f.command(op.targetPath, "switch", "--detach", op.candidateHead!);
  await assert.rejects(
    createWorktreeService(f.options).publishIntegration(params),
    /Target.*changed/,
  );
  assert.equal(await f.command(f.repo, "rev-parse", "other"), op.targetHead);
  const persisted = await service.getIntegration({ operationId: op.id });
  assert.ok(persisted);
  assert.notEqual(persisted.status, "published");
});
