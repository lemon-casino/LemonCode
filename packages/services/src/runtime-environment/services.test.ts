import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedServiceReceipt, RuntimeEnvironmentRecord } from "@lcode/shared";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";
import { nextGenerationAfter, reconcileStartIntent } from "./domain/services.js";
import {
  startManagedService,
  stopManagedService,
  type ServiceStageContext,
} from "./app/serviceStage.js";

const RECORD: RuntimeEnvironmentRecord = {
  environmentId: "e".repeat(32),
  scope: { workspacePath: "C:/proj" },
  purpose: "worktree",
  status: "ready",
  currentRevision: 1,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
};
const DEFINITION = {
  serviceId: "dev-server",
  purpose: "project dev server",
  argv: ["pnpm", "dev"],
  cwd: "C:/proj",
  ports: [5173],
};

function fakeProcesses(options: { urls?: string[]; stopConfirms?: boolean } = {}) {
  const exits: Array<(exitCode: number) => Promise<void>> = [];
  const calls = { starts: 0, stops: 0 };
  return {
    calls,
    exits,
    port: {
      start: async () => {
        calls.starts++;
        return { pid: 4242, urls: options.urls ?? ["http://127.0.0.1:5173"] };
      },
      stop: async () => {
        calls.stops++;
        return options.stopConfirms === false ? undefined : { exitCode: 0 };
      },
      onExit: (
        _key: { environmentId: string; serviceId: string; generation: number },
        callback: (exitCode: number) => Promise<void>,
      ) => {
        exits.push(callback);
      },
    },
  };
}

async function fixture(
  action: (
    context: ServiceStageContext,
    process: ReturnType<typeof fakeProcesses>,
  ) => Promise<void>,
  options: Parameters<typeof fakeProcesses>[0] = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "lcode-m3-services-"));
  try {
    const store = createRuntimeEnvironmentStore(dir);
    await store.saveEnvironment(RECORD);
    const process = fakeProcesses(options);
    await action(
      {
        store,
        processes: process.port,
        probe: async () => true,
        stamp: () => new Date().toISOString(),
      },
      process,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const latest = (context: ServiceStageContext) =>
  context.store.readServiceReceipt(RECORD.environmentId, DEFINITION.serviceId);

test("running requires verified URLs; stop proof clears URLs and next start increments generation", async () => {
  await fixture(async (context, process) => {
    const first = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(first.status, "started");
    assert.equal(first.receipt?.state, "running");
    assert.equal(first.receipt?.generation, 1);
    assert.ok(first.receipt?.healthCheckedAt);
    assert.deepEqual(first.receipt?.urls, ["http://127.0.0.1:5173"]);
    const reused = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(reused.status, "reused");
    assert.equal(process.calls.starts, 1);
    const stopped = await stopManagedService(context, RECORD, DEFINITION.serviceId);
    assert.equal(stopped.status, "stopped");
    assert.ok(stopped.receipt?.stoppedAt);
    assert.deepEqual(stopped.receipt?.urls, []);
    const second = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(second.status, "started");
    assert.equal(second.receipt?.generation, 2);
  });
});

for (const urls of [[], ["http://127.0.0.1:5173", "http://127.0.0.1:5174"]]) {
  test(`zero or partially verified URLs must not become running (${urls.length} URLs)`, async () => {
    await fixture(
      async (context, process) => {
        context.probe = async (url) => url.endsWith(":5173");
        const result = await startManagedService(context, RECORD, DEFINITION);
        assert.equal(result.status, "failed");
        assert.equal(result.receipt?.state, "failed");
        assert.deepEqual(result.receipt?.urls, []);
        assert.ok(result.receipt?.stoppedAt);
        assert.equal(process.calls.stops, 1);
      },
      { urls },
    );
  });
}

test("untrusted or credential-bearing URLs are rejected even when a probe returns true", async () => {
  await fixture(
    async (context) => {
      const result = await startManagedService(context, RECORD, DEFINITION);
      assert.equal(result.status, "failed");
      assert.deepEqual(result.receipt?.urls, []);
      assert.doesNotMatch(JSON.stringify(result), /secret/);
    },
    { urls: ["http://user:secret@127.0.0.1:5173"] },
  );
});

test("revision mismatch requires an explicit stop before a new generation", async () => {
  await fixture(async (context) => {
    await startManagedService(context, RECORD, DEFINITION);
    const updated = { ...RECORD, currentRevision: 2 };
    await context.store.saveEnvironment(updated);
    const result = await startManagedService(context, updated, DEFINITION);
    assert.equal(result.status, "needsRestart");
    assert.equal((await latest(context))?.generation, 1);
  });
});

test("failed without stoppedAt is not notRunning and cannot be restarted", async () => {
  await fixture(
    async (context, process) => {
      await startManagedService(context, RECORD, DEFINITION);
      const first = await stopManagedService(context, RECORD, DEFINITION.serviceId);
      assert.equal(first.status, "stopFailed");
      assert.equal(first.receipt?.stoppedAt, undefined);
      assert.deepEqual(first.receipt?.urls, []);
      const repeated = await stopManagedService(context, RECORD, DEFINITION.serviceId);
      assert.equal(repeated.status, "stopFailed");
      assert.equal((await startManagedService(context, RECORD, DEFINITION)).status, "blocked");
      assert.equal(process.calls.starts, 1);
    },
    { stopConfirms: false },
  );
});

test("unknown Host ownership neither trusts old URLs nor stops by persisted PID", async () => {
  await fixture(async (context, process) => {
    await context.store.saveServiceReceipt({
      environmentId: RECORD.environmentId,
      revision: 1,
      serviceId: DEFINITION.serviceId,
      generation: 7,
      state: "running",
      urls: ["http://127.0.0.1:5173"],
      pid: 4242,
      startedAt: RECORD.createdAt,
    });
    const start = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(start.status, "blocked");
    assert.equal(start.receipt?.state, "unknown");
    assert.deepEqual(start.receipt?.urls, []);
    assert.equal(
      (await stopManagedService(context, RECORD, DEFINITION.serviceId)).status,
      "blocked",
    );
    assert.deepEqual(process.calls, { starts: 0, stops: 0 });
  });
});

test("concurrent starts share admission while a slow spawn does not hold the environment lock", async () => {
  await fixture(async (context, process) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = process.port.start;
    process.port.start = async () => {
      entered.resolve();
      await release.promise;
      return original();
    };
    const first = startManagedService(context, RECORD, DEFINITION);
    await entered.promise;
    try {
      await context.store.lock(RECORD.environmentId, async () => {
        assert.equal((await latest(context))?.state, "starting");
      });
      const concurrent = await startManagedService(context, RECORD, DEFINITION);
      assert.equal(concurrent.status, "reused");
      assert.equal(concurrent.receipt?.state, "starting");
    } finally {
      release.resolve();
    }
    assert.equal((await first).status, "started");
    assert.equal(process.calls.starts, 1);
  });
});

test("exit while probing cannot be overwritten by late running settlement", async () => {
  await fixture(async (context, process) => {
    context.probe = async () => {
      await process.exits[0]!(23);
      return true;
    };
    const result = await startManagedService(context, RECORD, DEFINITION);
    assert.notEqual(result.status, "started");
    assert.ok((await latest(context))?.stoppedAt);
    assert.deepEqual((await latest(context))?.urls, []);
  });
});

test("old generation exit callback cannot overwrite the new generation", async () => {
  await fixture(async (context, process) => {
    await startManagedService(context, RECORD, DEFINITION);
    await stopManagedService(context, RECORD, DEFINITION.serviceId);
    await startManagedService(context, RECORD, DEFINITION);
    await process.exits[0]!(143);
    const current = await latest(context);
    assert.equal(current?.generation, 2);
    assert.equal(current?.state, "running");
    await process.exits[1]!(0);
    assert.equal((await latest(context))?.state, "stopped");
    assert.deepEqual((await latest(context))?.urls, []);
  });
});

test("leases survive an unconfirmed stop and release once only after real exit", async () => {
  await fixture(
    async (context, process) => {
      let releases = 0;
      context.acquireLease = async () => ({
        token: "private-lease",
        release: async () => {
          releases++;
        },
      });
      await startManagedService(context, RECORD, DEFINITION);
      await stopManagedService(context, RECORD, DEFINITION.serviceId);
      assert.equal(releases, 0);
      await process.exits[0]!(0);
      await process.exits[0]!(0);
      assert.equal(releases, 1);
      assert.deepEqual((await latest(context))?.urls, []);
    },
    { stopConfirms: false },
  );
});

test("busy lease settles admitted generation without spawning or leaking the lock diagnostic", async () => {
  await fixture(async (context, process) => {
    context.acquireLease = async () => {
      throw new Error("private/lock/token");
    };
    const result = await startManagedService(context, RECORD, DEFINITION);
    assert.equal(result.status, "failed");
    assert.ok(result.receipt?.stoppedAt);
    assert.equal(process.calls.starts, 0);
    assert.doesNotMatch(JSON.stringify(result), /private\/lock/);
  });
});

test("truly simultaneous starts from two callers admit only one owned generation", async () => {
  await fixture(async (context, process) => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => startManagedService(context, RECORD, DEFINITION)),
    );
    assert.equal(process.calls.starts, 1);
    assert.equal(results.filter((result) => result.status === "started").length, 1);
    assert.ok(results.every((result) => result.receipt?.generation === 1));
  });
});

test("other Host returns unknown without corrupting a live owner's persistent receipt", async () => {
  await fixture(async (context) => {
    await startManagedService(context, RECORD, DEFINITION);
    const other = fakeProcesses();
    const result = await startManagedService(
      { ...context, processes: other.port },
      RECORD,
      DEFINITION,
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.receipt?.state, "unknown");
    assert.deepEqual(result.receipt?.urls, []);
    assert.equal((await latest(context))?.state, "running");
    assert.equal((await startManagedService(context, RECORD, DEFINITION)).status, "reused");
    assert.equal(
      (await stopManagedService(context, RECORD, DEFINITION.serviceId)).status,
      "stopped",
    );
  });
});

test("stop during slow start cannot be overwritten by a late running result", async () => {
  await fixture(async (context, process) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = process.port.start;
    process.port.start = async () => {
      entered.resolve();
      await release.promise;
      return original();
    };
    const start = startManagedService(context, RECORD, DEFINITION);
    await entered.promise;
    const originalSave = context.store.saveServiceReceipt;
    const stopping = Promise.withResolvers<void>();
    context.store.saveServiceReceipt = async (receipt) => {
      await originalSave(receipt);
      if (receipt.state === "stopping") stopping.resolve();
    };
    const stop = stopManagedService(context, RECORD, DEFINITION.serviceId);
    await stopping.promise;
    await context.store.lock(RECORD.environmentId, async () => {});
    release.resolve();
    assert.notEqual((await start).status, "started");
    assert.equal((await stop).status, "stopped");
    assert.ok((await latest(context))?.stoppedAt);
    assert.deepEqual((await latest(context))?.urls, []);
    assert.equal(process.calls.starts, 1);
  });
});

test("scope/revision changed between preparation and spawn rejects the old admission", async () => {
  await fixture(async (context, process) => {
    context.prepareLaunch = async (_record, definition) => {
      await context.store.lock(RECORD.environmentId, () =>
        context.store.saveEnvironment({
          ...RECORD,
          scope: { ...RECORD.scope, workspaceIdentity: "another-owner" },
        }),
      );
      return definition;
    };
    assert.equal((await startManagedService(context, RECORD, DEFINITION)).status, "failed");
    assert.equal(process.calls.starts, 0);
    assert.ok((await latest(context))?.stoppedAt);
  });
});

test("start intent requires positive exit proof before a new generation", () => {
  const existing = { generation: 3, revision: 1, state: "failed" } as ManagedServiceReceipt;
  assert.equal(nextGenerationAfter(existing), 4);
  assert.equal(nextGenerationAfter(null), 1);
  assert.equal(reconcileStartIntent({ existing: null, requestedRevision: 1 }).action, "start");
  assert.equal(reconcileStartIntent({ existing, requestedRevision: 1 }).action, "blocked");
  assert.equal(
    reconcileStartIntent({
      existing: { ...existing, stoppedAt: RECORD.updatedAt },
      requestedRevision: 1,
    }).action,
    "start",
  );
});
