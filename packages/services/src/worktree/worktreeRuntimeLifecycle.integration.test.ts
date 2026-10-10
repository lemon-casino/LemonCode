import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { PreparedWorktreeRuntime, WorktreeRuntimePorts } from "./contract.js";
import { createPublicWorktreeService, createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

function runtimePorts() {
  const environments = new Map<string, PreparedWorktreeRuntime>();
  const prepares: Parameters<NonNullable<WorktreeRuntimePorts["prepareRuntimeEnvironment"]>>[0][] = [];
  const stages: string[] = [];
  const ports: WorktreeRuntimePorts = {
    prepareRuntimeEnvironment: async (params, writer) => {
      prepares.push(params);
      assert.equal(writer?.workspacePath, params.checkoutPath);
      const key = `${params.bindingId}:${params.requestId}`;
      let value = environments.get(key);
      if (!value) {
        value = { environmentId: params.operation === "restore" ? "b".repeat(32) : "a".repeat(32), revision: params.operation === "upgrade" ? 2 : 1, manifestDigest: `manifest-${params.operation ?? "prepare"}`, dependenciesPrepared: true };
        environments.set(key, value);
      }
      return value;
    },
    resolveRuntimeEnvironment: async ({ environmentRef }) => {
      const value = [...environments.values()].find((entry) => entry.environmentId === environmentRef.environmentId && entry.revision === environmentRef.revision);
      assert.ok(value);
      return value;
    },
    releaseRuntimeEnvironment: async (params) => {
      assert.equal(params.binding?.id, params.bindingId);
      stages.push(`${params.intent}:${params.phase}:${params.requestId}`);
      return { status: "completed" };
    },
    rebindRuntimeEnvironmentSessions: async ({ oldEnvironmentRef, newEnvironmentRef }) => {
      assert.notDeepEqual(oldEnvironmentRef, newEnvironmentRef);
      return { sessionIds: ["owner", "child", "hidden"] };
    },
  };
  return { ports, prepares, stages };
}

async function managed(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const runtime = runtimePorts();
  const service = createWorktreeService({ ...f.options, ...runtime.ports });
  const binding = await service.prepare({ workspacePath: f.repo, requestId: "owner", taskId: "owner", environmentPolicy: "managed", setupCommands: [] });
  return { ...f, ...runtime, service, binding };
}

test("managed discard fences before collect, confirms stop before journal/purge, and retains files on purge failure", async (t) => {
  const f = await managed(t);
  const calls: string[] = [];
  let blockStop = true;
  let failPurge = true;
  const service = createWorktreeService({ ...f.options, ...f.ports,
    releaseRuntimeEnvironment: async (params) => {
      const stored = await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" });
      assert.equal(stored?.status, "deleting");
      assert.equal(params.requestId, "discard-original");
      calls.push(params.phase);
      if (params.phase === "stop" && blockStop) return { status: "releaseBlocked", reason: "process still running" };
      return { status: "completed" };
    },
    collectDiscardSessions: async () => { assert.equal(calls.at(-1), "fence"); calls.push("collect"); return ["hidden", "child"]; },
    discardSessions: async (_, ids) => {
      assert.deepEqual(ids, ["hidden", "child"]);
      const stored = await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" });
      assert.deepEqual(stored?.deletion?.sessionIds, ids);
      await access(f.binding.checkoutPath);
      calls.push("purge");
      if (failPurge) throw new Error("purge failed");
    },
    fault: async (point) => { if (point === "discard.after-remove") calls.push("removed"); },
  });
  const request = { bindingId: f.binding.id, requestId: "discard-original", discard: { branch: f.binding.branch, checkoutPath: f.binding.checkoutPath } };
  await assert.rejects(service.archive(request), /process still running/);
  assert.deepEqual(calls, ["fence", "collect", "stop"]);
  assert.equal((await service.getBinding({ workspacePath: f.repo, taskId: "owner" }))?.deletion?.sessionIds, undefined);
  await access(f.binding.checkoutPath);
  blockStop = false;
  await assert.rejects(service.archive({ ...request, requestId: "retry-id" }), /purge failed/);
  await access(f.binding.checkoutPath);
  assert.notEqual(await f.command(f.repo, "branch", "--list", f.binding.branch), "");
  failPurge = false;
  assert.equal((await service.archive({ ...request, requestId: "retry-again" })).status, "deleted");
  // 每次重入都重新收集完整范围（规范要求），成功尝试为 fence → collect → stop → purge → …
  assert.deepEqual(calls.slice(-7), ["fence", "collect", "stop", "purge", "removed", "cleanup", "finalize"]);
  await assert.rejects(access(f.binding.checkoutPath), { code: "ENOENT" });
});

test("resource finalization failure stays deleting and journaled session IDs survive restart", async (t) => {
  const f = await managed(t);
  let collects = 0;
  let purges = 0;
  let blocked = true;
  const options = { ...f.options, ...f.ports,
    collectDiscardSessions: async () => { collects++; return ["owner"]; },
    discardSessions: async () => { purges++; },
    releaseRuntimeEnvironment: async (params: Parameters<NonNullable<WorktreeRuntimePorts["releaseRuntimeEnvironment"]>>[0]) => params.phase === "finalize" && blocked ? { status: "releaseBlocked" as const, reason: "resource busy" } : { status: "completed" as const },
  };
  const request = { bindingId: f.binding.id, requestId: "discard", discard: { branch: f.binding.branch, checkoutPath: f.binding.checkoutPath } };
  await assert.rejects(createWorktreeService(options).archive(request), /resource busy/);
  assert.equal((await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" }))?.status, "deleting");
  await assert.rejects(access(f.binding.checkoutPath), { code: "ENOENT" });
  blocked = false;
  assert.equal((await createWorktreeService(options).archive(request)).status, "deleted");
  // 每次重入都重新收集完整范围；两次尝试各收集一次，purge 仍保持幂等。
  assert.equal(collects, 2);
  assert.equal(purges, 2);
});

test("archive preserves sessions and stable recovery journal; restore creates new environment and retries session CAS", async (t) => {
  const f = await managed(t);
  await writeFile(join(f.binding.checkoutPath, "new.txt"), "snapshot\n");
  let failArchive = true;
  let failRebind = true;
  let rebinds = 0;
  const options = { ...f.options, ...f.ports,
    collectDiscardSessions: async () => { throw new Error("archive must not collect or purge"); },
    discardSessions: async () => { throw new Error("archive must not purge"); },
    rebindRuntimeEnvironmentSessions: async (params: Parameters<NonNullable<WorktreeRuntimePorts["rebindRuntimeEnvironmentSessions"]>>[0]) => {
      rebinds++;
      assert.equal(params.requestId, "restore-original");
      assert.equal(params.oldEnvironmentRef.environmentId, f.binding.environmentRef?.environmentId);
      assert.equal(params.newEnvironmentRef.environmentId, "b".repeat(32));
      assert.equal(params.binding.status, "restoring");
      if (failRebind) throw new Error("session CAS unavailable");
      return { sessionIds: ["owner", "child", "hidden"] };
    },
    fault: async (point: string) => { if (point === "archive.after-remove" && failArchive) throw new Error("archive reply lost"); },
  };
  await assert.rejects(createWorktreeService(options).archive({ bindingId: f.binding.id, requestId: "archive-original" }), /archive reply lost/);
  assert.equal((await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" }))?.status, "archiving");
  failArchive = false;
  const archived = await createWorktreeService(options).archive({ bindingId: f.binding.id, requestId: "archive-retry" });
  assert.equal(archived.status, "archived");
  assert.equal(archived.deletion, undefined);
  assert.ok(f.stages.every((entry) => entry.endsWith(":archive-original")));
  await assert.rejects(createWorktreeService(options).restore({ bindingId: f.binding.id, requestId: "restore-original" }), /session CAS unavailable/);
  const pending = await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" });
  assert.equal(pending?.status, "restoring");
  assert.equal(pending?.environmentRebuild?.status, "failed");
  assert.equal(pending?.environmentRef?.environmentId, "b".repeat(32));
  failRebind = false;
  const restored = await createWorktreeService(options).restore({ bindingId: f.binding.id, requestId: "restore-retry" });
  assert.equal(restored.status, "ready");
  assert.equal(restored.environmentRebuild?.status, "ready");
  assert.deepEqual(restored.environmentRebuild?.sessionIds, ["owner", "child", "hidden"]);
  assert.equal(restored.archiveOperation, undefined);
  assert.equal(f.prepares.filter((params) => params.operation === "restore").length, 1);
  assert.equal(rebinds, 2);
  assert.equal(await readFile(join(restored.checkoutPath, "new.txt"), "utf8"), "snapshot\n");
});

test("restore Git fast path still rebuilds runtime after an interrupted file restoration", async (t) => {
  const f = await managed(t);
  await f.service.archive({ bindingId: f.binding.id, requestId: "archive" });
  const interrupted = createWorktreeService({ ...f.options, ...f.ports, fault: async (point) => { if (point === "restore.after-files") throw new Error("files restored reply lost"); } });
  await assert.rejects(interrupted.restore({ bindingId: f.binding.id, requestId: "restore" }), /reply lost/);
  assert.equal(f.prepares.length, 1);
  const restored = await f.service.restore({ bindingId: f.binding.id, requestId: "restore-retry" });
  assert.equal(restored.status, "ready");
  assert.equal(f.prepares.at(-1)?.requestId, "restore");
  assert.equal(f.prepares.at(-1)?.operation, "restore");
});

test("upgrade keeps environment identity, persists new ref before CAS and is excluded from public RPC", async (t) => {
  const f = await managed(t);
  const request = { bindingId: f.binding.id, requestId: "upgrade", expectedEnvironmentRef: f.binding.environmentRef! };
  const upgraded = await f.service.upgradeRuntimeEnvironment(request);
  assert.equal(upgraded.environmentRef?.environmentId, f.binding.environmentRef?.environmentId);
  assert.equal(upgraded.environmentRef?.revision, 2);
  assert.equal(upgraded.status, "ready");
  assert.deepEqual(f.stages, ["upgrade:fence:upgrade", "upgrade:stop:upgrade"]);
  assert.equal(f.prepares.at(-1)?.requestId, "upgrade");
  assert.equal((await f.service.upgradeRuntimeEnvironment(request)).environmentRef?.revision, 2);
  assert.equal(f.prepares.length, 2);
  assert.equal("upgradeRuntimeEnvironment" in createPublicWorktreeService(f.service), false);
});

test("discard completes for a managed binding cancelled before any environment was allocated", async (t) => {
  const f = await fixture(t);
  let releases = 0;
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const options = {
    ...f.options,
    // 卡在 checkout 之后、环境阶段之前，精确复现「托管策略但环境从未分配」的取消。
    fault: async (point: string) => {
      if (point === "prepare.after-add") {
        entered();
        await gate;
      }
    },
    // 环境 owner 不可用：取消调用失败且不附带可对账的 operation，绑定因此不会写入任何引用。
    prepareRuntimeEnvironment: async () => {
      throw new Error("runtime environment owner is unavailable");
    },
    resolveRuntimeEnvironment: async () => {
      throw new Error("runtime environment owner is unavailable");
    },
    releaseRuntimeEnvironment: async () => {
      releases++;
      return { status: "completed" as const };
    },
  };
  const service = createWorktreeService(options);
  const request = {
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
    environmentPolicy: "managed" as const,
    setupCommands: [],
  };
  const preparing = service.prepare(request);
  const rejected = assert.rejects(preparing, /cancelled/i);
  await started;
  // 取消请求本身可以失败；持久取消墓碑仍然生效并中止在途准备。
  await assert.rejects(service.prepare({ ...request, cancel: true }), /unavailable/);
  finish();
  await rejected;
  const cancelled = (await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" }))!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.environmentPolicy, "managed");
  assert.equal(cancelled.environmentRef, undefined);
  assert.equal(cancelled.preparation?.activeStep, "checkout");
  // 没有可释放的环境资源，删除必须完成而不是永久卡在 deleting。
  const deleted = await service.archive({
    bindingId: cancelled.id,
    requestId: "discard",
    discard: { branch: cancelled.branch, checkoutPath: cancelled.checkoutPath },
  });
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.error, undefined);
  assert.equal(releases, 0);
  await assert.rejects(access(cancelled.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "branch", "--list", cancelled.branch), "");
});
