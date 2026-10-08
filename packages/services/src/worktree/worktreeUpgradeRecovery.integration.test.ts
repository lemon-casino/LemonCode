import assert from "node:assert/strict";
import test from "node:test";
import type { WorktreeRuntimePorts } from "./contract.js";
import { createWorktreeService } from "./node.js";
import { fixture } from "./testFixture.js";

const reference = (revision: number) => ({
  environmentId: "a".repeat(32),
  revision,
  manifestDigest: `manifest-${revision}`,
});
async function managed(t: Parameters<typeof fixture>[0], ports: WorktreeRuntimePorts) {
  const f = await fixture(t);
  const service = createWorktreeService({
    ...f.options,
    resolveRuntimeEnvironment: async ({ environmentRef }) => ({
      ...environmentRef,
      manifestDigest: environmentRef.manifestDigest!,
    }),
    releaseRuntimeEnvironment: async () => ({ status: "completed" }),
    rebindRuntimeEnvironmentSessions: async () => ({ sessionIds: ["owner"] }),
    ...ports,
  });
  const binding = await service.prepare({
    workspacePath: f.repo,
    taskId: "owner",
    requestId: "owner",
    setupCommands: [],
    environmentPolicy: "managed",
  });
  return { ...f, service, binding };
}

test("settled cancelled upgrade keeps its fence, rejects the old ID and accepts an explicit new ID", async (t) => {
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const f = await managed(t, {
    prepareRuntimeEnvironment: async (params) => {
      if (params.cancel) {
        stopped.resolve();
        throw Object.assign(new Error("cancelled"), { operation: { status: "cancelled" } });
      }
      if (params.requestId === "cancel-me") {
        entered.resolve();
        await stopped.promise;
        throw new Error("preparation cancelled");
      }
      return reference(params.operation === "upgrade" ? 2 : 1);
    },
  });
  const request = {
    bindingId: f.binding.id,
    requestId: "cancel-me",
    expectedEnvironmentRef: reference(1),
  };
  const active = assert.rejects(f.service.upgradeRuntimeEnvironment(request), /cancelled/);
  await entered.promise;
  const cancelled = await f.service.upgradeRuntimeEnvironment({ ...request, cancel: true });
  await active;
  assert.equal(cancelled.status, "updating");
  assert.equal(cancelled.environmentUpgrade?.cancelled, true);
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /cancelled/);
  const restarted = createWorktreeService({
    ...f.options,
    prepareRuntimeEnvironment: async () => reference(2),
    resolveRuntimeEnvironment: async () => reference(2),
    releaseRuntimeEnvironment: async () => ({ status: "completed" }),
    rebindRuntimeEnvironmentSessions: async () => ({ sessionIds: ["owner"] }),
  });
  await assert.rejects(
    restarted.upgradeRuntimeEnvironment({
      ...request,
      requestId: "new",
      expectedEnvironmentRef: reference(9),
    }),
    /stale/,
  );
  const ready = await restarted.upgradeRuntimeEnvironment({ ...request, requestId: "new" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.environmentUpgrade?.requestId, "new");
  assert.notEqual(ready.environmentUpgrade?.cancelled, true);
});

test("new upgrade after cancellation settles an already-committed old session CAS before preparing again", async (t) => {
  const entered = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const calls: string[] = [];
  let first = true;
  let failRecovery = true;
  const f = await managed(t, {
    prepareRuntimeEnvironment: async (params) => {
      if (params.cancel) {
        stopped.resolve();
        return reference(2);
      }
      calls.push(`prepare:${params.requestId}`);
      return reference(params.operation !== "upgrade" ? 1 : params.requestId === "old" ? 2 : 3);
    },
    rebindRuntimeEnvironmentSessions: async (params) => {
      calls.push(
        `rebind:${params.requestId}:${params.oldEnvironmentRef.revision}->${params.newEnvironmentRef.revision}`,
      );
      assert.equal(params.binding.status, "updating");
      if (first) {
        first = false;
        entered.resolve();
        await stopped.promise;
        throw new Error("CAS interrupted");
      }
      if (params.requestId === "old" && failRecovery) throw new Error("CAS still unavailable");
      return { sessionIds: ["owner", "child"] };
    },
  });
  const request = {
    bindingId: f.binding.id,
    requestId: "old",
    expectedEnvironmentRef: reference(1),
  };
  const active = assert.rejects(f.service.upgradeRuntimeEnvironment(request), /CAS interrupted/);
  await entered.promise;
  await f.service.upgradeRuntimeEnvironment({ ...request, cancel: true });
  await active;
  const recovery = {
    ...request,
    requestId: "new",
    expectedEnvironmentRef: reference(2),
  };
  await assert.rejects(f.service.upgradeRuntimeEnvironment(recovery), /CAS still unavailable/);
  const blocked = await f.service.getBinding({ workspacePath: f.repo, taskId: "owner" });
  assert.equal(blocked?.status, "updating");
  assert.equal(blocked?.environmentUpgrade?.requestId, "old");
  assert.equal(blocked?.environmentUpgrade?.cancelled, true);
  assert.deepEqual(blocked?.environmentRebuild?.oldEnvironmentRef, reference(1));
  assert.deepEqual(blocked?.environmentRebuild?.newEnvironmentRef, reference(2));
  assert.equal(calls.includes("prepare:new"), false);
  failRecovery = false;
  const recovered = await f.service.upgradeRuntimeEnvironment(recovery);
  assert.equal(recovered.status, "ready");
  assert.deepEqual(calls.slice(1), [
    "prepare:old",
    "rebind:old:1->2",
    "rebind:old:1->2",
    "rebind:old:1->2",
    "prepare:new",
    "rebind:new:2->3",
  ]);
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /stale/);
});

test("uncancelled failure preserves the original journal and rejects replacement request IDs", async (t) => {
  let fail = true;
  const f = await managed(t, {
    prepareRuntimeEnvironment: async (params) => {
      if (params.operation === "upgrade" && fail) throw new Error("install failed");
      return reference(params.operation === "upgrade" ? 2 : 1);
    },
  });
  const request = {
    bindingId: f.binding.id,
    requestId: "original",
    expectedEnvironmentRef: reference(1),
  };
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /install failed/);
  await assert.rejects(
    f.service.upgradeRuntimeEnvironment({ ...request, requestId: "other" }),
    /Finish the existing/,
  );
  fail = false;
  assert.equal((await f.service.upgradeRuntimeEnvironment(request)).status, "ready");
});

test("cancellation settles a lost successful preparation reply before admitting its replacement", async (t) => {
  const entered = Promise.withResolvers<void>();
  const receipt = Promise.withResolvers<void>();
  const rebinds: string[] = [];
  const f = await managed(t, {
    prepareRuntimeEnvironment: async (params) => {
      if (params.cancel) {
        entered.resolve();
        await receipt.promise;
        return reference(2);
      }
      if (params.requestId === "old") throw new Error("successful preparation reply lost");
      if (params.operation === "upgrade") assert.equal(params.expectedRevision, 2);
      return reference(params.operation === "upgrade" ? 3 : 1);
    },
    rebindRuntimeEnvironmentSessions: async (params) => {
      rebinds.push(`${params.oldEnvironmentRef.revision}->${params.newEnvironmentRef.revision}`);
      return { sessionIds: ["owner"] };
    },
  });
  const request = {
    bindingId: f.binding.id,
    requestId: "old",
    expectedEnvironmentRef: reference(1),
  };
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /reply lost/);
  const cancellation = f.service.upgradeRuntimeEnvironment({ ...request, cancel: true });
  await entered.promise;
  await assert.rejects(
    f.service.upgradeRuntimeEnvironment({ ...request, requestId: "new" }),
    /Finish the existing/,
  );
  receipt.resolve();
  const cancelled = await cancellation;
  assert.equal(cancelled.environmentUpgrade?.cancelled, true);
  assert.deepEqual(cancelled.environmentRef, reference(2));
  assert.deepEqual(cancelled.environmentRebuild?.oldEnvironmentRef, reference(1));
  assert.equal(
    (
      await f.service.upgradeRuntimeEnvironment({
        ...request,
        requestId: "new",
        expectedEnvironmentRef: reference(2),
      })
    ).status,
    "ready",
  );
  assert.deepEqual(rebinds, ["1->2", "2->3"]);
});

test("a terminal failed runtime receipt can cancel a failed upgrade without resurrecting the old ID", async (t) => {
  const f = await managed(t, {
    prepareRuntimeEnvironment: async (params) => {
      if (params.requestId === "failed")
        throw Object.assign(new Error("install failed"), { operation: { status: "failed" } });
      return reference(params.operation === "upgrade" ? 2 : 1);
    },
  });
  const request = {
    bindingId: f.binding.id,
    requestId: "failed",
    expectedEnvironmentRef: reference(1),
  };
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /install failed/);
  const cancelled = await f.service.upgradeRuntimeEnvironment({ ...request, cancel: true });
  assert.equal(cancelled.environmentUpgrade?.cancelled, true);
  await assert.rejects(f.service.upgradeRuntimeEnvironment(request), /cancelled/);
  assert.equal(
    (await f.service.upgradeRuntimeEnvironment({ ...request, requestId: "new" })).status,
    "ready",
  );
});
