import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { WorktreeRuntimePorts } from "./contract.js";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

async function candidate(t: Parameters<typeof fixture>[0], ports: WorktreeRuntimePorts = {}) {
  const f = await fixture(t);
  const service = createWorktreeService({ ...f.options, ...ports });
  const binding = await service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
    setupCommands: [],
    environmentPolicy: ports.prepareRuntimeEnvironment ? "managed" : "local",
  });
  await writeFile(join(binding.checkoutPath, "feature.txt"), "feature\n");
  await f.command(binding.checkoutPath, "add", ".");
  await f.command(binding.checkoutPath, "commit", "-m", "feature");
  const op = await service.integrate({
    bindingId: binding.id,
    requestId: "merge",
    expectedSourceHead: await f.command(binding.checkoutPath, "rev-parse", "HEAD"),
    targetBranch: "main",
    validationCommands: [],
  });
  return {
    ...f,
    service,
    binding,
    op,
    approval: { operationId: op.id, approvedCandidateHead: op.candidateHead! },
  };
}

test("empty validation requires explicit durable skip and old ready cannot authorize publication", async (t) => {
  const f = await candidate(t);
  const blocked = await f.service.continueIntegration(f.approval);
  assert.equal(blocked.status, "awaiting-review");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), f.op.targetHead);
  const skipped = await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal(skipped.status, "ready");
  assert.equal(skipped.validationReceipts?.[0]?.outcome, "skipped");
  assert.equal(skipped.validationReceipts?.[0]?.skipAcknowledged, true);
  const file = join(f.options.dataDir, "operations", `${f.op.id}.json`);
  const old = JSON.parse(await readFile(file, "utf8"));
  delete old.candidateEvidence;
  delete old.validationReceipts;
  await writeFile(file, JSON.stringify(old));
  await assert.rejects(
    createWorktreeService(f.options).publishIntegration(f.approval),
    /evidence|receipt|review/i,
  );
  await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal((await f.service.publishIntegration(f.approval)).status, "published");
});

test("managed candidate has an independent environment, frozen env, exact bounded receipts and writer reuse", async (t) => {
  const calls: { purpose: string; path: string; writer: string | undefined }[] = [];
  let currentDigest = "manifest-candidate";
  const ports: WorktreeRuntimePorts = {
    prepareRuntimeEnvironment: async (params, writer) => {
      calls.push({
        purpose: params.purpose,
        path: params.checkoutPath,
        writer: writer?.workspacePath,
      });
      return {
        environmentId: (params.purpose === "worktree" ? "a" : "b").repeat(32),
        revision: 1,
        manifestDigest: params.purpose === "worktree" ? "manifest-task" : currentDigest,
        env: { CANDIDATE_ENV: "frozen" },
      };
    },
    resolveRuntimeEnvironment: async ({ environmentRef }) => ({
      ...environmentRef,
      manifestDigest:
        environmentRef.environmentId === "a".repeat(32) ? "manifest-task" : currentDigest,
      env: { CANDIDATE_ENV: "frozen" },
    }),
  };
  const f = await candidate(t, ports);
  const command = "x".repeat(6000);
  let runs = 0;
  const service = createWorktreeService({
    ...f.options,
    ...ports,
    validate: async (path, actual, _, env) => {
      assert.equal(path, f.op.checkoutPath);
      assert.equal(actual, command);
      assert.equal(env?.CANDIDATE_ENV, "frozen");
      runs++;
      return { exitCode: 0, output: "o".repeat(70000) };
    },
  });
  const ready = await service.continueIntegration({ ...f.approval, validationCommands: [command] });
  assert.equal(ready.status, "ready");
  assert.notEqual(ready.environmentRef?.environmentId, f.binding.environmentRef?.environmentId);
  assert.equal(calls.at(-1)?.purpose, "integration-candidate");
  assert.equal(calls.at(-1)?.writer, f.op.checkoutPath);
  assert.equal(ready.validationReceipts?.[0]?.command?.length, 6000);
  assert.equal(ready.validationReceipts?.[0]?.output.length, 65536);
  assert.equal(ready.validationReceipts?.[0]?.outputTruncated, true);
  assert.equal(ready.candidateEvidence?.sourceHead, f.op.sourceHead);
  assert.equal(ready.candidateEvidence?.targetHead, f.op.targetHead);
  currentDigest = "changed-manifest";
  await assert.rejects(
    service.publishIntegration(f.approval),
    /environment|manifest|evidence|stale/i,
  );
  assert.equal(runs, 1);
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), f.op.targetHead);
});

test("ignored declaration changes invalidate ready and explicit revalidation can replace evidence", async (t) => {
  const f = await candidate(t);
  await writeFile(join(f.repo, ".git", "info", "exclude"), "mise.toml\n");
  await writeFile(join(f.op.checkoutPath, "mise.toml"), "[tools]\nnode = '24'\n");
  await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  await writeFile(join(f.op.checkoutPath, "mise.toml"), "[tools]\nnode = '22'\n");
  await assert.rejects(f.service.publishIntegration(f.approval), /declaration|evidence|stale/i);
  await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal((await f.service.publishIntegration(f.approval)).status, "published");
});

test("lost publication reconciles target ancestry before touching removed candidate or runtime ports", async (t) => {
  const f = await candidate(t);
  await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  const service = createWorktreeService({
    ...f.options,
    fault: async (point) => {
      if (point === "publish.after-merge") throw new Error("lost reply");
    },
  });
  await assert.rejects(service.publishIntegration(f.approval), /lost reply/);
  await f.command(f.repo, "worktree", "remove", "--force", f.op.checkoutPath);
  await rm(f.op.checkoutPath, { recursive: true, force: true });
  const recovered = await createWorktreeService(f.options).publishIntegration(f.approval);
  assert.equal(recovered.status, "published");
  assert.equal(await f.command(f.repo, "rev-parse", "HEAD"), f.op.candidateHead);
});

test("failed candidate allocation retains revision zero for retry and cancellation cleanup after restart", async (t) => {
  const candidateId = "b".repeat(32);
  let fail = true;
  let blockStop = true;
  const releases: { phase: string; revision: number }[] = [];
  const ports: WorktreeRuntimePorts = {
    prepareRuntimeEnvironment: async (params) => {
      if (params.purpose === "integration-candidate" && fail)
        throw Object.assign(new Error("candidate install failed"), {
          operation: { environmentId: candidateId, status: "failed" },
        });
      if (params.purpose === "integration-candidate")
        assert.equal(params.environmentId, candidateId);
      return {
        environmentId: (params.purpose === "worktree" ? "a" : "b").repeat(32),
        revision: 1,
        manifestDigest: "manifest",
      };
    },
    resolveRuntimeEnvironment: async ({ environmentRef }) => ({
      ...environmentRef,
      manifestDigest: "manifest",
    }),
    releaseRuntimeEnvironment: async (params) => {
      assert.equal(params.environmentRef.environmentId, candidateId);
      releases.push({ phase: params.phase, revision: params.environmentRef.revision });
      return params.phase === "stop" && blockStop
        ? { status: "releaseBlocked", reason: "stop unconfirmed" }
        : { status: "completed" };
    },
  };
  const f = await candidate(t, ports);
  const failed = await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal(failed.status, "validation-failed");
  assert.deepEqual(failed.environmentRef, { environmentId: candidateId, revision: 0 });
  const restarted = createWorktreeService({ ...f.options, ...ports });
  assert.deepEqual(
    (await restarted.getIntegration({ operationId: f.op.id }))?.environmentRef,
    failed.environmentRef,
  );
  fail = false;
  const ready = await restarted.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal(ready.status, "ready");
  assert.equal(ready.environmentRef?.revision, 1);
  // 首次失败的零代引用也必须可清理；另一个候选保持原失败状态覆盖此分支。
  const other = await candidate(t, {
    ...ports,
    prepareRuntimeEnvironment: async (params) => {
      if (params.purpose === "integration-candidate")
        throw Object.assign(new Error("install failed"), {
          operation: { environmentId: candidateId, status: "failed" },
        });
      return { environmentId: "a".repeat(32), revision: 1, manifestDigest: "manifest" };
    },
  });
  await other.service.continueIntegration({ ...other.approval, skipValidation: true });
  await assert.rejects(
    other.service.continueIntegration({ operationId: other.op.id, cancel: true }),
    /stop unconfirmed/,
  );
  blockStop = false;
  assert.equal(
    (await other.service.continueIntegration({ operationId: other.op.id, cancel: true })).status,
    "cancelled",
  );
  assert.deepEqual(
    releases.map(({ phase }) => phase),
    ["fence", "stop", "fence", "stop", "cleanup", "finalize"],
  );
  assert.ok(releases.every(({ revision }) => revision === 0));
});

test("failed candidate environment update preserves its existing positive cleanup reference", async (t) => {
  let fail = false;
  const ports: WorktreeRuntimePorts = {
    prepareRuntimeEnvironment: async (params) => {
      if (fail && params.purpose === "integration-candidate")
        throw Object.assign(new Error("update failed"), {
          operation: { environmentId: "b".repeat(32), status: "failed" },
        });
      return {
        environmentId: (params.purpose === "worktree" ? "a" : "b").repeat(32),
        revision: 1,
        manifestDigest: "manifest",
      };
    },
    resolveRuntimeEnvironment: async ({ environmentRef }) => ({
      ...environmentRef,
      manifestDigest: "manifest",
    }),
  };
  const f = await candidate(t, ports);
  const ready = await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  fail = true;
  const failed = await f.service.continueIntegration({ ...f.approval, skipValidation: true });
  assert.equal(failed.status, "validation-failed");
  assert.deepEqual(failed.environmentRef, ready.environmentRef);
});
