import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createGitService } from "../git/gitService.js";
import { GitCommitMessageGenerator } from "../git/gitCommitMessageGenerator.js";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

async function committedTask(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  await writeFile(join(binding.workspacePath, "feature.txt"), "feature\n");
  await f.command(binding.workspacePath, "add", ".");
  await f.command(binding.workspacePath, "commit", "-m", "feature");
  const request = {
    bindingId: binding.id,
    requestId: "integration",
    expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
    validationCommands: ["fixture-check"],
  };
  return { ...f, binding, request };
}

test("cancelling preserves candidate and source commits, survives restart and permits a fresh target", async (t) => {
  const f = await committedTask(t);
  const op = await f.service.integrate(f.request);
  const cancel = { operationId: op.id, cancel: true };
  await assert.rejects(
    f.service.archive({ bindingId: f.binding.id, requestId: "active" }),
    /finish the integration/,
  );
  await assert.rejects(
    f.service.continueIntegration({ ...cancel, approvedCandidateHead: op.candidateHead }),
    /Cancellation cannot/,
  );
  assert.equal((await f.service.continueIntegration(cancel)).status, "cancelled");
  assert.equal(
    (await createWorktreeService(f.options).continueIntegration(cancel)).status,
    "cancelled",
  );
  assert.equal(await f.command(op.checkoutPath, "rev-parse", "HEAD"), op.candidateHead);
  assert.equal(await f.command(f.binding.checkoutPath, "rev-parse", "HEAD"), op.sourceHead);
  await assert.rejects(
    f.service.continueIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead }),
    /not ready/,
  );
  await assert.rejects(
    f.service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /cancelled/,
  );
  await f.command(f.repo, "branch", "target");
  await assert.rejects(
    f.service.integrate({ ...f.request, requestId: "other-target", targetBranch: "target" }),
    /currently checked out/,
  );
  await f.command(f.repo, "switch", "target");
  const next = await f.service.integrate({
    ...f.request,
    requestId: "other-target",
    targetBranch: "target",
  });
  assert.notEqual(next.id, op.id);
  assert.equal(next.targetBranch, "target");
  assert.equal((await f.service.getIntegration({ operationId: op.id }))?.status, "cancelled");
  await f.service.continueIntegration({ operationId: next.id, cancel: true });
  assert.equal(
    (await f.service.archive({ bindingId: f.binding.id, requestId: "archive" })).status,
    "archived",
  );
  assert.equal(await f.command(op.checkoutPath, "rev-parse", "HEAD"), op.candidateHead);
});

test("publication facts cannot be cancelled or reverted", async (t) => {
  const f = await committedTask(t);
  const service = createWorktreeService({
    ...f.options,
    validate: async () => ({ exitCode: 0, output: "checked" }),
    fault: async (point) => {
      if (point === "publish.before-merge") throw new Error("interrupted publication");
    },
  });
  const op = await service.integrate(f.request);
  await service.continueIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead,
  });
  await assert.rejects(
    service.publishIntegration({ operationId: op.id, approvedCandidateHead: op.candidateHead! }),
    /interrupted publication/,
  );
  await assert.rejects(
    service.continueIntegration({ operationId: op.id, cancel: true }),
    /cannot be cancelled/,
  );
  await createWorktreeService(f.options).publishIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead!,
  });
  await assert.rejects(
    service.continueIntegration({ operationId: op.id, cancel: true }),
    /cannot be cancelled/,
  );
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), op.candidateHead);
});

test("configured validation commands execute in the integration checkout and persist failure output", async (t) => {
  for (const exitCode of [0, 7]) {
    const f = await committedTask(t);
    const command = `node -e "process.stdout.write(process.cwd());process.exit(${exitCode})"`;
    const op = await f.service.integrate({ ...f.request, validationCommands: [command] });
    const result = await f.service.continueIntegration({
      operationId: op.id,
      approvedCandidateHead: op.candidateHead,
    });
    assert.equal(result.status, exitCode ? "validation-failed" : "ready");
    assert.equal(result.validationResults[0]?.exitCode, exitCode);
    assert.equal(result.validationResults[0]?.output, op.checkoutPath);
    assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), op.targetHead);
  }
});

test("review validates the exact candidate once; publication recovery never reruns validation", async (t) => {
  const f = await committedTask(t);
  let validations = 0;
  let failPublish = true;
  const service = createWorktreeService({
    ...f.options,
    validate: async (path) => {
      assert.notEqual(path, f.repo);
      validations++;
      return { exitCode: 0, output: "checked" };
    },
    fault: async (point) => {
      if (point === "publish.before-merge" && failPublish) {
        failPublish = false;
        throw new Error("response-lost");
      }
    },
  });
  const operation = await service.integrate(f.request);
  await assert.rejects(
    service.continueIntegration({
      operationId: operation.id,
      approvedCandidateHead: f.request.expectedSourceHead,
    }),
    /exact new commit/,
  );
  const ready = await service.continueIntegration({
    operationId: operation.id,
    approvedCandidateHead: operation.candidateHead,
  });
  assert.equal(ready.status, "ready");
  assert.equal(validations, 1);
  await assert.rejects(readFile(join(f.repo, "feature.txt")), { code: "ENOENT" });
  const publish = { operationId: operation.id, approvedCandidateHead: operation.candidateHead! };
  await assert.rejects(service.publishIntegration(publish), /response-lost/);
  assert.equal((await service.getIntegration({ operationId: operation.id }))?.status, "publishing");
  assert.equal((await service.publishIntegration(publish)).status, "published");
  assert.equal(validations, 1);
  assert.equal(await readFile(join(f.repo, "feature.txt"), "utf8"), "feature\n");
  assert.equal(
    (await createWorktreeService(f.options).publishIntegration(publish)).status,
    "published",
  );
});

test("validation errors and candidate writes stay visible and block target publication", async (t) => {
  const f = await committedTask(t);
  let mode = "fail";
  const service = createWorktreeService({
    ...f.options,
    validate: async (path) => {
      if (mode === "fail") throw new Error("fixture-check-failed");
      await writeFile(join(path, "feature.txt"), "formatter changed\n");
      return { exitCode: 0, output: "formatted" };
    },
  });
  const operation = await service.integrate(f.request);
  const approve = { operationId: operation.id, approvedCandidateHead: operation.candidateHead };
  const failed = await service.continueIntegration(approve);
  assert.equal(failed.status, "validation-failed");
  assert.match(failed.validationResults[0]!.output, /fixture-check-failed/);
  mode = "write";
  const changed = await service.continueIntegration(approve);
  assert.equal(changed.status, "awaiting-review");
  await assert.rejects(
    service.publishIntegration({ ...approve, approvedCandidateHead: operation.candidateHead! }),
    /uncommitted/,
  );
  await assert.rejects(readFile(join(f.repo, "feature.txt")), { code: "ENOENT" });
});

test("record-before-binding interruption reconnects the original integration on retry", async (t) => {
  const f = await committedTask(t);
  let fail = true;
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "integrate.after-record" && fail) {
        fail = false;
        throw new Error("record-interrupted");
      }
    },
  });
  await assert.rejects(service.integrate(f.request), /record-interrupted/);
  const operation = await createWorktreeService(f.options).integrate(f.request);
  assert.equal(operation.status, "awaiting-review");
  assert.equal(
    (await service.getBinding({ workspacePath: f.repo, taskId: "A" }))?.latestIntegrationId,
    operation.id,
  );
  assert.equal((await service.integrate(f.request)).id, operation.id);
});

test("combined reviewed commits recover a lost first receipt after Git service restart", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "x.ts"), "a\nb\n");
  await f.command(f.repo, "add", ".");
  await f.command(f.repo, "commit", "-m", "two lines");
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const path = join(binding.workspacePath, "x.ts");
  await writeFile(path, "A\nB\n");
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      readCurrentModel: async () => ({ providerId: "fixture", modelId: "fixture" }),
    },
    textGenerator: {
      generateText: async (params) => {
        const data = JSON.parse(params.prompt.split("\n").at(-1)!) as { groups: { id: string }[] };
        return {
          text: JSON.stringify({
            decision: "keep",
            warnings: [],
            messages: data.groups.map((group) => ({ id: group.id, message: `feat: ${group.id}` })),
            mergedMessage: "feat: combined",
          }),
          selection: params.selection,
        };
      },
    },
  });
  let gitService = createGitService({
    commitMessageGenerator: generator,
    mutationJournalReader: async () => ({
      complete: true,
      mutations: [
        {
          id: "write-A",
          sessionId: "A",
          path,
          beforeContent: "a\nb\n",
          afterContent: "A\nb\n",
          toolName: "Edit",
          createdAt: 1,
        },
        {
          id: "write-B",
          sessionId: "B",
          path,
          beforeContent: "A\nb\n",
          afterContent: "A\nB\n",
          toolName: "Edit",
          createdAt: 2,
        },
      ],
    }),
  });
  const draft = await gitService.generateCommitMessage({
    workspacePath: binding.workspacePath,
    review: true,
    currentSessionFilePaths: [path],
  });
  assert.equal(draft.review!.groups.length, 2);
  let fail = true;
  const options = {
    ...f.options,
    commitSource: (request: Parameters<typeof gitService.commit>[0]) => gitService.commit(request),
    fault: async (point: string) => {
      if (point === "integrate.after-source-commit" && fail) {
        fail = false;
        throw new Error("receipt-lost");
      }
    },
  };
  const service = createWorktreeService(options);
  const request = {
    bindingId: binding.id,
    requestId: "combined",
    expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
    targetBranch: "main",
    sourceCommits: draft.review!.groups.map((group) => ({
      workspacePath: binding.workspacePath,
      message: group.message,
      review: { id: draft.review!.id, groupId: group.id, acknowledged: true },
    })),
  };
  const first = await service.integrate(request);
  assert.equal(first.status, "source-commit-failed");
  assert.equal(first.sourceReceipts!.length, 0);
  gitService = createGitService();
  const afterRestart = await createWorktreeService(options).integrate(request);
  assert.equal(afterRestart.sourceReceipts!.length, 1);
  assert.equal(afterRestart.status, "source-commit-failed");
  // 已完成组可恢复，未提交组的内存审核已丢失，必须重新审核，不伪造自动成功。
  assert.match(afterRestart.error!, /审核/);
  assert.equal(await f.command(binding.workspacePath, "rev-list", "--count", "HEAD"), "3");
  assert.equal(await f.command(binding.workspacePath, "show", "HEAD:x.ts"), "A\nb");
  assert.equal((await service.integrate(request)).sourceReceipts!.length, 1);
});

test("a saved source warning blocks all integration retries without repeating the commit", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  let commits = 0;
  const head = await f.command(binding.workspacePath, "rev-parse", "HEAD");
  const service = createWorktreeService({
    ...f.options,
    commitSource: async () => {
      commits++;
      return {
        commitHash: head,
        warning: "manual-index-recovery",
        summary: await createGitService().getRepositorySummary({
          workspacePath: binding.workspacePath,
        }),
      };
    },
  });
  const request = {
    bindingId: binding.id,
    requestId: "warning",
    expectedSourceHead: head,
    targetBranch: "main",
    sourceCommits: [
      {
        workspacePath: binding.workspacePath,
        message: "feat: A",
        review: { id: "review", groupId: "A", acknowledged: true },
      },
    ],
  };
  const result = await service.integrate(request);
  assert.equal(result.status, "source-commit-failed");
  assert.equal((await service.integrate(request)).status, "source-commit-failed");
  assert.equal(commits, 1);
  assert.equal(result.sourceReceipts![0]!.warning, "manual-index-recovery");
});
