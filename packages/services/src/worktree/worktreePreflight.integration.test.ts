import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

async function task(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  return {
    ...f,
    binding,
    request: {
      bindingId: binding.id,
      requestId: "merge",
      expectedSourceHead: await f.command(binding.workspacePath, "rev-parse", "HEAD"),
      targetBranch: "main",
      validationCommands: ["must-not-run"],
    },
  };
}

test("已包含来源返回独立终态，重启/重试不创建候选或验证，归档不被锁住", async (t) => {
  const f = await task(t);
  let validations = 0;
  const service = createWorktreeService({
    ...f.options,
    validate: async () => {
      validations++;
      return { exitCode: 0, output: "unexpected" };
    },
  });
  const before = await f.command(f.repo, "rev-parse", "HEAD");
  const result = await service.integrate(f.request);
  assert.equal(result.status, "up-to-date");
  assert.equal(result.mergeResult?.kind, "already-contained");
  assert.equal(result.mergeResult?.changedFiles, 0);
  assert.equal(validations, 0);
  await assert.rejects(access(result.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), before);
  const restarted = createWorktreeService(f.options);
  assert.equal((await restarted.integrate(f.request)).id, result.id);
  assert.equal(
    (await restarted.continueIntegration({ operationId: result.id })).status,
    "up-to-date",
  );
  assert.equal(
    (await restarted.archive({ bindingId: f.binding.id, requestId: "archive" })).status,
    "archived",
  );
});

test("未提交文件必须明确排除，预检查仅读取，已包含不冒充提交成功", async (t) => {
  const f = await task(t);
  const path = join(f.binding.workspacePath, "uncommitted.txt");
  await writeFile(path, "keep me\n");
  const preflight = await f.service.getIntegrationPreflight({
    bindingId: f.binding.id,
    targetBranch: "main",
  });
  assert.equal(preflight.alreadyContained, true);
  assert.equal(preflight.sourceCommitCount, 0);
  assert.equal(preflight.uncommittedFileCount, 1);
  assert.equal(
    (await f.service.getBinding({ workspacePath: f.repo, taskId: "A" }))?.latestIntegrationId,
    undefined,
  );
  await assert.rejects(f.service.integrate(f.request), /Uncommitted source changes/);
  const result = await f.service.integrate({ ...f.request, acknowledgeUncommitted: true });
  assert.equal(result.status, "up-to-date");
  assert.equal(result.mergeResult?.uncommittedFileCount, 1);
  assert.equal(await readFile(path, "utf8"), "keep me\n");
  assert.equal(await f.command(f.binding.workspacePath, "diff", "--cached", "--name-only"), "");
});

test("预检查不能授权后来出现的未提交文件或旧来源 HEAD", async (t) => {
  const f = await task(t);
  await f.service.getIntegrationPreflight({ bindingId: f.binding.id, targetBranch: "main" });
  await writeFile(join(f.binding.workspacePath, "later.txt"), "later\n");
  await assert.rejects(f.service.integrate(f.request), /Uncommitted source changes/);
  await f.command(f.binding.workspacePath, "add", ".");
  await f.command(f.binding.workspacePath, "commit", "-m", "later");
  await assert.rejects(f.service.integrate(f.request), /HEAD.*changed/);
});

test("独有提交而树相同仍可审核并保留历史，不因空 diff 阻止合并", async (t) => {
  const f = await task(t);
  await f.command(f.binding.workspacePath, "commit", "--allow-empty", "-m", "history only");
  const source = await f.command(f.binding.workspacePath, "rev-parse", "HEAD");
  const op = await f.service.integrate({
    ...f.request,
    expectedSourceHead: source,
    validationCommands: [],
  });
  assert.equal(op.status, "awaiting-review");
  assert.equal(op.mergeResult?.kind, "history-only");
  assert.equal(op.mergeResult?.sourceCommitCount, 1);
  assert.equal(op.mergeResult?.changedFiles, 0);
  const result = await f.service.publishIntegration({
    operationId: op.id,
    approvedCandidateHead: op.candidateHead!,
    skipValidation: true,
  });
  assert.equal(result.status, "published");
  assert.equal(
    (
      await f.options.git.run({
        cwd: f.repo,
        args: ["merge-base", "--is-ancestor", source, "HEAD"],
      })
    ).exitCode,
    0,
  );
});

test("二进制文件按真实 Git 树计为内容变化", async (t) => {
  const f = await task(t);
  await writeFile(join(f.binding.workspacePath, "binary.dat"), Buffer.from([0, 1, 2, 0, 3]));
  await f.command(f.binding.workspacePath, "add", ".");
  await f.command(f.binding.workspacePath, "commit", "-m", "binary");
  const op = await f.service.integrate({
    ...f.request,
    expectedSourceHead: await f.command(f.binding.workspacePath, "rev-parse", "HEAD"),
  });
  assert.equal(op.mergeResult?.kind, "content");
  assert.equal(op.mergeResult?.changedFiles, 1);
});
