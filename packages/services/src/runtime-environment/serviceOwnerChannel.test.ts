import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeEnvironmentRecord,
  RuntimeEnvironmentServiceActionParams,
} from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { createManagedServiceProcesses } from "./adapters/managedServices.js";
import { createServiceOwnerChannel } from "./adapters/serviceOwnerChannel.js";
import { createServiceControl } from "./app/serviceControl.js";

const script = String.raw`const http=require('node:http');const s=http.createServer((q,r)=>r.end('owned'));s.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));`;
async function fixture(
  action: (value: {
    root: string;
    record: RuntimeEnvironmentRecord;
    params: RuntimeEnvironmentServiceActionParams;
    a: ReturnType<typeof host>;
    b: ReturnType<typeof host>;
  }) => Promise<void>,
  beforeStart?: () => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "lcode-service-owner-"));
  const store = createRuntimeEnvironmentStore(root);
  const record: RuntimeEnvironmentRecord = {
    environmentId: "c".repeat(32),
    scope: { workspacePath: root, workspaceIdentity: "owner-test" },
    currentRevision: 1,
    status: "ready",
    purpose: "worktree",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await store.saveEnvironment(record);
  const params = {
    ...record.scope,
    environmentId: record.environmentId,
    serviceId: "http",
    requestId: "start-1",
    expectedRevision: 1,
  };
  function host() {
    const processes = createManagedServiceProcesses({
      definitions: { http: { portEnvironment: ["PORT"] } },
    });
    const control = createServiceControl({
      store,
      processes,
      beforeStart,
      resolveDefinition: async () => ({
        serviceId: "http",
        argv: [process.execPath, "-e", script],
        cwd: root,
        purpose: "test",
      }),
      resolveContext: async (current) => ({
        environmentId: current.environmentId,
        revision: current.currentRevision,
        manifestDigest: "frozen",
        executionScope: current.scope,
        cwd: root,
        toolPaths: { node: process.execPath },
        envOverlay: { base: "inherit" },
        resourceLeaseToken: "private",
      }),
    });
    const channel = createServiceOwnerChannel(root, {
      owns: control.owns,
      handle: control.handleOwnerRequest,
      requestTimeoutMs: 10_000,
    });
    control.attachOwnerChannel(channel);
    return { store, control, processes, channel };
  }
  const a = host();
  const b = host();
  try {
    await action({ root, record, params, a, b });
  } finally {
    await Promise.all([a.processes.disposeAndWait(), b.processes.disposeAndWait()]);
    await Promise.all([a.channel.disposeAndWait(), b.channel.disposeAndWait()]);
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "two Hosts share one real HTTP owner and peer start/query/stop routes back to its handle",
  { timeout: 40_000 },
  async () => {
    await fixture(async ({ a, b, params, record, root }) => {
      const started = await a.control.startService(params);
      assert.equal(started.status, "started");
      const receipt = started.receipt!;
      const peer = await b.control.startService({ ...params, requestId: "peer-start" });
      assert.equal(peer.status, "reused");
      assert.equal(peer.receipt?.generation, receipt.generation);
      assert.equal(b.processes.isAlive(receipt), false);
      assert.equal((await b.control.reconcileReceipt(record, receipt)).state, "running");
      assert.equal(await (await fetch(receipt.urls[0]!)).text(), "owned");
      const routeFile = (await readdir(join(root, "service-owner-routes"))).find((name) =>
        name.endsWith(".json"),
      )!;
      if (process.platform !== "win32")
        assert.equal((await stat(join(root, "service-owner-routes", routeFile))).mode & 0o077, 0);
      const stopped = await b.control.stopService({
        ...params,
        requestId: "peer-stop",
        expectedGeneration: receipt.generation,
      });
      assert.equal(stopped.status, "stopped");
      assert.ok(stopped.receipt?.stoppedAt);
      assert.deepEqual(stopped.receipt?.urls, []);
      await assert.rejects(fetch(receipt.urls[0]!, { signal: AbortSignal.timeout(1000) }));
      const restarted = await b.control.startService({
        ...params,
        requestId: "explicit-next",
        expectedGeneration: 1,
      });
      assert.equal(restarted.status, "started");
      assert.equal(restarted.receipt?.generation, 2);
      await a.channel.remove(receipt);
      assert.equal((await a.control.reconcileReceipt(record, restarted.receipt!)).state, "running");
      assert.equal(
        (await a.control.stopService({ ...params, expectedGeneration: 1 })).status,
        "needsRestart",
      );
      assert.equal(b.processes.isAlive(restarted.receipt!), true);
    });
  },
);

test(
  "lost owner channel projects unknown without overwriting live facts, restarting or killing by PID",
  { timeout: 30_000 },
  async () => {
    await fixture(async ({ a, b, params, record }) => {
      const receipt = (await a.control.startService(params)).receipt!;
      await a.channel.disposeAndWait(); // 模拟控制通道消失，但没有进程退出证明。
      const projection = await b.control.reconcileReceipt(record, receipt);
      assert.equal(projection.state, "unknown");
      assert.deepEqual(projection.urls, []);
      assert.equal(
        (await b.control.startService({ ...params, requestId: "no-resurrection" })).status,
        "blocked",
      );
      assert.equal(
        (await b.control.stopService({ ...params, requestId: "unknown-stop" })).status,
        "blocked",
      );
      assert.equal(
        (await a.store.readServiceReceipt(record.environmentId, "http"))?.state,
        "running",
      );
      assert.equal(await (await fetch(receipt.urls[0]!)).text(), "owned");
      assert.equal(a.processes.isAlive(receipt), true);
    });
  },
);

test(
  "wrong route secret is rejected without disclosing private routing data or touching the process",
  { timeout: 30_000 },
  async () => {
    await fixture(async ({ a, b, params, record, root }) => {
      const receipt = (await a.control.startService(params)).receipt!;
      const directory = join(root, "service-owner-routes");
      const file = join(
        directory,
        (await readdir(directory)).find((name) => name.endsWith(".json"))!,
      );
      const route = JSON.parse(await readFile(file, "utf8")) as {
        endpoint: string;
        secret: string;
      };
      await writeFile(file, JSON.stringify({ ...route, secret: "f".repeat(64) }), { mode: 0o600 });
      const result = await b.control.stopService(params);
      assert.equal(result.status, "blocked");
      assert.equal(result.receipt?.state, "unknown");
      assert.ok(!JSON.stringify(result).includes(route.secret));
      assert.ok(!JSON.stringify(result).includes(route.endpoint));
      assert.equal((await b.control.reconcileReceipt(record, receipt)).state, "unknown");
      assert.equal(a.processes.isAlive(receipt), true);
      await a.channel.remove(receipt);
      assert.equal(
        (JSON.parse(await readFile(file, "utf8")) as { secret: string }).secret,
        "f".repeat(64),
      );
    });
  },
);

test(
  "beforeStart runs once outside environment lock; another Host reuses the admitted starting generation",
  { timeout: 30_000 },
  async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    await fixture(
      async ({ a, b, params, record }) => {
        const started = a.control.startService(params);
        await entered.promise;
        try {
          await a.store.lock(record.environmentId, async () => {});
          const peer = await b.control.startService({
            ...params,
            requestId: "peer-during-prepare",
          });
          assert.equal(peer.status, "reused");
          assert.equal(peer.receipt?.state, "starting");
          assert.equal(calls, 1);
        } finally {
          release.resolve();
        }
        assert.equal((await started).status, "started");
        assert.equal(calls, 1);
      },
      async () => {
        calls++;
        entered.resolve();
        await release.promise;
      },
    );
  },
);

test(
  "shutdown waits for exit callbacks so stopped receipts are persisted before owner channel closes",
  { timeout: 30_000 },
  async () => {
    await fixture(async ({ a, params, record }) => {
      const receipt = (await a.control.startService(params)).receipt!;
      await a.processes.disposeAndWait();
      const stopped = await a.store.readServiceReceipt(record.environmentId, receipt.serviceId);
      assert.equal(stopped?.state, "stopped");
      assert.deepEqual(stopped?.urls, []);
      assert.ok(stopped?.stoppedAt);
    });
  },
);
