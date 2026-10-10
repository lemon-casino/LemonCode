import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LCodeAgentProcessManager } from "../lcode-agent/lcodeAgentProcessManager.js";
import type { ILCodeAgentService } from "../lcode-agent/lcodeAgent.js";
import { createCheckoutCoordinator, createWorktreeService } from "../worktree/node.js";
import { fixture } from "./legacyDiscard.fixture.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createRuntimeEnvironmentService } from "./app/runtimeEnvironmentService.js";
import { createRuntimeConsumerAuthority } from "./app/consumerLifecycle.js";
import { createWorktreeEnvironmentRelease } from "./app/worktreeRelease.js";
import { createWorktreeRuntimePorts } from "./worktreeWiring.js";
import { createNativeProcessOwnerObserver } from "./adapters/processOwnerObservation.js";
import { createRuntimeResources } from "./adapters/resources.js";
import { rm, writeFile } from "node:fs/promises";

const oldOwner = "runtime-agent-11111111-1111-4111-8111-111111111111";
const incarnation = "22222222-2222-4222-8222-222222222222";

async function setup(
  t: TestContext,
  options: {
    observeProcessOwner?: import("./contract.js").RuntimeProcessOwnerObserver;
    modernPid?: number;
    actualExitedOwner?: boolean;
  } = {},
) {
  const f = await fixture(t);
  let actualOwner: import("./contract.js").RuntimeConsumerProcessOwner | undefined;
  let manager: LCodeAgentProcessManager | undefined;
  if (options.actualExitedOwner) {
    // 使用生产 manager 冻结身份，模拟原项目 Agent 退出但旧 Host 没保存环境退出收据。
    manager = new LCodeAgentProcessManager({
      commandResolver: () => ({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        cwd: f.repo,
      }),
    });
    t.after(() => manager!.disposeAllAndWait());
    const client = await manager.getClient({ workspacePath: f.repo });
    actualOwner = manager.getOwnedProcessOwner(client);
    assert.ok(actualOwner?.pid);
    options.modernPid = actualOwner.pid;
    options.observeProcessOwner = createNativeProcessOwnerObserver((owner) =>
      manager!.hasOwnedProcessOwner(owner),
    );
  }
  const store = createRuntimeEnvironmentStore(join(f.root, "environments"));
  let cleanupFails = false;
  const resources = createRuntimeResources(join(f.root, "environments"), async (path) => {
    if (cleanupFails) throw Object.assign(new Error("fixture cache locked"), { code: "EBUSY" });
    await rm(path, { recursive: true, force: true });
  });
  const stamp = () => new Date().toISOString();
  const authority = createRuntimeConsumerAuthority(store, stamp, options.observeProcessOwner);
  const runtime = createRuntimeEnvironmentService({
    store,
    ensureResources: (id) => resources.ensure(id),
    declarations: {
      read: async () => ({ tools: [], lockfiles: [], ambiguousLocks: false, issues: [] }),
    },
    backend: {
      ensureBackend: async () => "unused",
      probeBackend: async () => ({ available: true }),
      installTool: async ({ key }) => ({ toolPath: join(f.root, "tools", key) }),
    },
  });
  const coordinator = createCheckoutCoordinator(f.options);
  let stopped = false;
  let purgeFails = false;
  let stopFails = false;
  let collects = 0;
  const writers: string[] = [];
  let service!: ReturnType<typeof createWorktreeService>;
  const ports = createWorktreeRuntimePorts({
    host: {
      service: runtime,
      prepareUnderWriter: runtime.prepareUnderWriter,
      consumers: authority,
      releaseForWorktree: createWorktreeEnvironmentRelease({
        store,
        stamp,
        stopAll: async () => ({ status: "stopped" }),
        clearRebuildable: (id) => resources.clearRebuildable(id),
        discardResources: (id) => resources.discard(id),
        observeProcessOwner: options.observeProcessOwner,
      }),
    },
    coordinator,
    worktrees: () => service,
    agents: () => ({}) as ILCodeAgentService,
    stopWorktreeExecution: async () => {
      if (stopFails) throw new Error("fixture stop failed");
      stopped = true;
    },
  });
  const discardSessions: NonNullable<
    import("../worktree/node.js").WorktreeServiceOptions["discardSessions"]
  > = async (binding, ids, writer) => {
    assert.ok(stopped);
    if (purgeFails) throw new Error("fixture purge failed");
    writers.push(writer.ownerId);
    const current = await service.getBinding({ workspacePath: f.repo, taskId: "owner" });
    assert.deepEqual(current?.deletion?.sessionIds, ids);
    await authority.releaseSessionsAfterDeletion({
      workspacePath: binding.checkoutPath,
      environmentId: binding.environmentRef!.environmentId,
      bindingId: binding.id,
      sessionIds: ids,
    });
  };
  const worktreeOptions = {
    ...f.options,
    coordinator,
    ...ports,
    collectDiscardSessions: async () => {
      collects++;
      return ["owner", "hidden"];
    },
    discardSessions,
  };
  service = createWorktreeService(worktreeOptions);
  const binding = await service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "prepare",
    environmentPolicy: "managed",
    setupCommands: [],
  });
  const scope = { workspacePath: binding.checkoutPath };
  const ref = binding.environmentRef!;
  const ownerId = actualOwner
    ? `runtime-agent-${actualOwner.runtimeInstanceId}`
    : options.modernPid === undefined
      ? oldOwner
      : `runtime-agent-agent-${oldOwner.slice("runtime-agent-".length)}`;
  for (const id of ["owner", "hidden"])
    await authority.acquire({
      ...scope,
      ...ref,
      kind: "session",
      id,
      ownerId: `binding:${binding.id}`,
    });
  const processReference = await authority.acquire(
    {
      ...scope,
      ...ref,
      kind: "process",
      id: JSON.stringify(["hidden", incarnation]),
      ownerId,
    },
    options.modernPid === undefined
      ? undefined
      : (actualOwner ?? {
          runtimeInstanceId: ownerId.slice("runtime-agent-".length),
          runtimeGeneration: 1,
          startedAt: Date.now(),
          workspacePath: f.repo,
          pid: options.modernPid,
        }),
  );
  if (manager) await manager.disposeWorkspace({ workspacePath: f.repo });
  const request = {
    bindingId: binding.id,
    requestId: "discard-original",
    discard: { branch: binding.branch, checkoutPath: binding.checkoutPath },
  };
  return {
    ...f,
    options: worktreeOptions,
    service,
    store,
    authority,
    resources,
    binding,
    process: processReference,
    scope,
    ref,
    request,
    coordinator,
    writers,
    setPurgeFails: (value: boolean) => {
      purgeFails = value;
    },
    setStopFails: (value: boolean) => {
      stopFails = value;
    },
    setCleanupFails: (value: boolean) => {
      cleanupFails = value;
    },
    getCollects: () => collects,
  };
}

test("existing confirmed delete completes a legacy managed checkout without another user action", async (t) => {
  const f = await setup(t);
  assert.equal((await f.service.archive(f.request)).status, "deleted");
  await assert.rejects(access(f.binding.checkoutPath), { code: "ENOENT" });
  assert.equal(await f.command(f.repo, "branch", "--list", f.binding.branch), "");
  const audit = await f.store.listConsumerRetirements(f.ref.environmentId);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.reason, "confirmed-worktree-discard");
  assert.equal(audit[0]!.requestId, f.request.requestId);
  assert.equal(audit[0]!.lease, f.process.lease);
  assert.deepEqual(await f.store.listConsumerOwnerReceipts(f.ref.environmentId), []);
  assert.equal((await f.store.readEnvironment(f.ref.environmentId))?.status, "released");
});

test("stop and purge failures keep old references; retry retains original journal and session IDs", async (t) => {
  const f = await setup(t);
  f.setStopFails(true);
  await assert.rejects(f.service.archive(f.request), /stop failed/);
  f.setStopFails(false);
  f.setPurgeFails(true);
  await assert.rejects(f.service.archive({ ...f.request, requestId: "retry-one" }), /purge failed/);
  assert.equal(
    (await f.store.listConsumers(f.ref.environmentId)).find((ref) => ref.kind === "process")?.state,
    "active",
  );
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  f.setPurgeFails(false);
  assert.equal(
    (await createWorktreeService(f.options).archive({ ...f.request, requestId: "retry-two" }))
      .status,
    "deleted",
  );
  assert.deepEqual(f.writers, [`discard:${f.request.requestId}`]);
  assert.equal(f.getCollects(), 3);
});

test("another checkout reader blocks migration until the exclusive writer is available", async (t) => {
  const f = await setup(t);
  const lease = await f.coordinator.acquire({
    workspacePath: f.binding.checkoutPath,
    ownerId: "other-reader",
    mode: "shared",
  });
  try {
    await assert.rejects(f.service.archive(f.request), /busy/i);
  } finally {
    await f.coordinator.release(lease);
  }
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  assert.equal((await f.service.archive({ ...f.request, requestId: "retry" })).status, "deleted");
});

test("an active modern owner and a foreign legacy session still block confirmed deletion", async (t) => {
  for (const modern of [false, true]) {
    const f = await setup(t);
    await f.authority.acquire(
      {
        ...f.scope,
        ...f.ref,
        kind: "process",
        id: JSON.stringify([modern ? "owner" : "foreign", "33333333-3333-4333-8333-333333333333"]),
        ownerId: modern ? "runtime-agent-44444444-4444-4444-8444-444444444444" : oldOwner,
      },
      modern
        ? {
            runtimeInstanceId: "44444444-4444-4444-8444-444444444444",
            runtimeGeneration: 1,
            startedAt: Date.now(),
            workspacePath: f.binding.workspacePath,
          }
        : undefined,
    );
    await assert.rejects(f.service.archive(f.request), /execution owner has not confirmed exit/);
    await access(f.binding.checkoutPath);
    assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  }
});

test("saving a snapshot cannot retire legacy process references", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.service.archive({ bindingId: f.binding.id, requestId: "archive" }),
    /execution owner has not confirmed exit/,
  );
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
});

test("confirmed delete recovers an absent modern original-project Agent without claiming tree exit", async (t) => {
  const f = await setup(t, {
    actualExitedOwner: true,
    observeProcessOwner: createNativeProcessOwnerObserver(() => false),
  });
  f.setStopFails(true);
  await assert.rejects(f.service.archive(f.request), /stop failed/);
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  f.setStopFails(false);
  const reader = await f.coordinator.acquire({
    workspacePath: f.binding.checkoutPath,
    ownerId: "reader",
    mode: "shared",
  });
  try {
    await assert.rejects(f.service.archive(f.request), /busy/i);
    assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  } finally {
    await f.coordinator.release(reader);
  }
  f.setPurgeFails(true);
  await assert.rejects(f.service.archive(f.request), /purge failed/);
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  f.setPurgeFails(false);
  const result = await createWorktreeService(f.options).archive({
    ...f.request,
    requestId: "retry",
  });
  assert.equal(result.status, "deleted");
  await assert.rejects(access(f.binding.checkoutPath), { code: "ENOENT" });
  const [audit] = await f.store.listConsumerRetirements(f.ref.environmentId);
  const [owner] = await f.store.listConsumerOwnerReceipts(f.ref.environmentId);
  assert.equal(audit?.requestId, f.request.requestId);
  assert.equal(audit?.lease, f.process.lease);
  assert.deepEqual(audit?.orphanedOwner?.processOwner, owner?.processOwner);
  assert.ok(audit?.orphanedOwner?.observedAt);
  assert.equal(owner?.processOwner.workspacePath, f.repo);
  assert.equal(owner?.exitConfirmedAt, undefined);
  assert.equal((await f.store.readEnvironment(f.ref.environmentId))?.status, "released");
});

test("present, unknown and unavailable modern owners remain protected", async (t) => {
  for (const state of ["present", "unknown", undefined] as const) {
    const f = await setup(t, {
      modernPid: 123456789,
      observeProcessOwner: state === undefined ? undefined : () => state,
    });
    await assert.rejects(f.service.archive(f.request), /execution owner has not confirmed exit/);
    assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
    await access(f.binding.checkoutPath);
  }
});

test("modern recovery rechecks presence after purge and protects changed leases", async (t) => {
  let observations = 0;
  const f = await setup(t, {
    modernPid: 123456789,
    observeProcessOwner: () => (++observations === 1 ? "absent" : "present"),
  });
  await assert.rejects(f.service.archive(f.request), /release-blocked/);
  assert.equal(observations, 2);
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
  assert.equal(
    (await f.store.listConsumers(f.ref.environmentId)).find((ref) => ref.kind === "process")?.state,
    "active",
  );
  const g = await setup(t, { modernPid: 123456789, observeProcessOwner: () => "absent" });
  const refs = await g.store.listConsumers(g.ref.environmentId);
  await g.store.saveConsumers(
    g.ref.environmentId,
    refs.map((ref) => (ref.kind === "process" ? { ...ref, lease: "different-lease" } : ref)),
  );
  await assert.rejects(g.service.archive(g.request), /execution owner has not confirmed exit/);
  assert.deepEqual(await g.store.listConsumerRetirements(g.ref.environmentId), []);
});

test("modern orphan recovery cannot run during snapshot archive", async (t) => {
  const f = await setup(t, { modernPid: 123456789, observeProcessOwner: () => "absent" });
  await assert.rejects(
    f.service.archive({ bindingId: f.binding.id, requestId: "snapshot" }),
    /execution owner has not confirmed exit/,
  );
  assert.deepEqual(await f.store.listConsumerRetirements(f.ref.environmentId), []);
});

test("one confirmation retries private cleanup after checkout removal and deletes private data", async (t) => {
  const f = await setup(t);
  const dirs = await f.resources.ensure(f.ref.environmentId);
  await writeFile(join(dirs.data, "database"), "keep");
  await writeFile(join(dirs.cache, "payload"), "rebuildable");
  f.setCleanupFails(true);
  assert.equal(
    (
      await createWorktreeService({
        ...f.options,
        transientRetryWait: async ({ requestId }) => {
          assert.equal(requestId, f.request.requestId);
          await assert.rejects(access(f.binding.checkoutPath), { code: "ENOENT" });
          assert.equal((await f.store.readEnvironment(f.ref.environmentId))?.status, "releasing");
          await access(dirs.cache);
          f.setCleanupFails(false);
        },
      }).archive(f.request)
    ).status,
    "deleted",
  );
  await assert.rejects(access(dirs.cache), { code: "ENOENT" });
  await assert.rejects(access(dirs.data), { code: "ENOENT" });
  assert.equal((await f.store.readEnvironment(f.ref.environmentId))?.status, "released");
});
