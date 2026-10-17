import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSessionStore } from "../index.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import { acquireWorkflowJournalOwner } from "./repositories/workflow-journal-owner.js";
import type { RunRecord } from "@lcode/dynamic-workflow";

const run = (id = "live", parentSessionId = "parent"): RunRecord => ({
  runId: id,
  parentSessionId,
  status: "running",
  caps: { maxConcurrency: 1 },
  spentTokens: 0,
});

async function fixture(t: TestContext, beforeClose?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lcode-workflow-owner-"));
  const path = join(directory, "sessions.sqlite");
  const store = createSqliteSessionStore({ dbPath: path });
  const db = new DatabaseSync(path);
  t.after(async () => {
    await beforeClose?.();
    db.close();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const journal = createDwfJournalStore(db);
  const acquire = (
    probeOwner?: Parameters<typeof acquireWorkflowJournalOwner>[0]["probeOwner"],
    workspaceKey = "fixture-identity",
  ) =>
    acquireWorkflowJournalOwner({
      db,
      journal,
      parentSessionId: "parent",
      workspaceKey,
      ...(probeOwner ? { probeOwner } : {}),
    });
  return { path, store, db, journal, acquire };
}

test("live owner blocks another service; retired generation fences every old journal writer", async (t) => {
  const f = await fixture(t);
  const first = await f.acquire();
  first.journal.createRun(run());
  await assert.rejects(f.acquire(), { code: "owner_active" });
  assert.equal(f.journal.getRun("live")?.status, "running");
  first.release();
  const second = await f.acquire();
  assert.equal(second.generation, first.generation + 1);
  assert.throws(() => first.journal.updateRunStatus("live", "completed"), {
    code: "owner_changed",
  });
  assert.throws(
    () =>
      first.journal.appendEvent("live", {
        type: "run-started",
        runId: "live",
        caps: { maxConcurrency: 1 },
      }),
    { code: "owner_changed" },
  );
  assert.equal(
    second.reconcileInterrupted("live", "running", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "fixture interrupted" },
    }),
    true,
  );
  assert.equal(
    second.reconcileInterrupted("live", "running", { stopReason: "interrupted" }),
    false,
  );
  assert.equal(f.journal.getRun("live")?.stopReason, "interrupted");
  first.release(); // 迟到旧 release 不得退休新 owner。
  second.assertOwned();
  second.release();
});

test("legacy non-terminal rows and different workspace identities require owner proof", async (t) => {
  const f = await fixture(t);
  f.journal.createRun(run());
  await assert.rejects(f.acquire(), { code: "owner_unknown" });
  assert.equal(f.journal.getRun("live")?.status, "running");
  f.journal.updateRunStatus("live", "completed");
  const lease = await f.acquire();
  await assert.rejects(f.acquire(undefined, "other-identity"), { code: "owner_unknown" });
  assert.throws(() => lease.journal.createRun(run("other", "sibling")), { code: "owner_changed" });
  lease.release();
});

test("two claimers with the same retirement proof have exactly one CAS winner", async (t) => {
  const f = await fixture(t);
  const original = await f.acquire();
  original.journal.createRun(run());
  let release!: () => void;
  const proof = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = async () => {
    await proof;
    return "retired" as const;
  };
  const a = f.acquire(probe);
  const b = f.acquire(probe);
  release();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) => result.status === "rejected" && result.reason.code === "owner_changed",
    ).length,
    1,
  );
  assert.throws(() => original.journal.updateRunUsage("live", 999), { code: "owner_changed" });
  for (const result of results) if (result.status === "fulfilled") result.value.release();
});

test("unknown process validity never retires an active owner", async (t) => {
  const f = await fixture(t);
  const original = await f.acquire();
  await assert.rejects(
    f.acquire(async () => "unknown"),
    { code: "owner_unknown" },
  );
  original.assertOwned();
  original.release();
});

for (const operation of ["appendEvent", "reconcileInterrupted"] as const) {
  test(`owner ${operation} acquires the WAL write lock before reading run scope`, async (t) => {
    let competing: DatabaseSync | undefined;
    const f = await fixture(t, async () => competing?.close());
    competing = new DatabaseSync(f.path);
    let interleave = () => {};
    const journal = new Proxy(f.journal, {
      get(target, key) {
        const member = Reflect.get(target, key, target);
        if (key === "getRun")
          return (id: string) => {
            const record = target.getRun(id);
            interleave();
            return record;
          };
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const lease = await acquireWorkflowJournalOwner({
      db: f.db,
      journal,
      parentSessionId: "parent",
      workspaceKey: "fixture-identity",
    });
    lease.journal.createRun(run());
    f.journal.createRun(run("sibling", "other-parent"));
    const ownerBefore = f.db.prepare("select * from local_setting").all();
    const writeSibling = () =>
      competing!
        .prepare("update dwf_run set spent_tokens = spent_tokens + 1 where id = ?")
        .run("sibling");
    let competingError: unknown;
    interleave = () => {
      interleave = () => {};
      try {
        writeSibling();
      } catch (error) {
        competingError = error;
      }
    };
    // 用另一真实连接卡住原实现的“已读 owner、尚未写事件”窗口，不能靠延时碰运气。
    const activity = { type: "log" as const, message: "fixture activity" };
    assert.doesNotThrow(() => {
      if (operation === "appendEvent") lease.journal.appendEvent("live", activity);
      else
        assert.equal(
          lease.reconcileInterrupted("live", "running", { stopReason: "interrupted" }),
          true,
        );
    });
    assert.equal((competingError as { errcode?: number })?.errcode, 5);
    assert.deepEqual(f.db.prepare("select * from local_setting").all(), ownerBefore);
    if (operation === "appendEvent") {
      const events = f.journal.listEvents("live");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.sequence, 0);
      assert.deepEqual(events[0]?.event, activity);
    } else {
      assert.equal(f.journal.getRun("live")?.stopReason, "interrupted");
      assert.equal(
        lease.reconcileInterrupted("live", "running", { stopReason: "interrupted" }),
        false,
      );
    }
    writeSibling();
    assert.equal(f.journal.getRun("sibling")?.spentTokens, 1);
    lease.release();
  });
}

test("failed journal writes roll back their savepoint and preserve the caller transaction", async (t) => {
  const f = await fixture(t);
  const failure = new Error("fixture journal write failed");
  const journal = new Proxy(f.journal, {
    get(target, key) {
      const member = Reflect.get(target, key, target);
      if (key === "appendEvent")
        return (...args: Parameters<typeof target.appendEvent>) => {
          target.appendEvent(...args);
          throw failure;
        };
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  const lease = await acquireWorkflowJournalOwner({
    db: f.db,
    journal,
    parentSessionId: "parent",
    workspaceKey: "fixture-identity",
  });
  lease.journal.createRun(run());
  f.db.exec("begin immediate");
  try {
    f.journal.updateRunUsage("live", 7);
    assert.throws(
      () => lease.journal.appendEvent("live", { type: "log", message: "rolled back" }),
      (error) => error === failure,
    );
    assert.deepEqual(f.journal.listEvents("live"), []);
    f.db.exec("commit");
  } catch (error) {
    f.db.exec("rollback");
    throw error;
  }
  assert.equal(f.journal.getRun("live")?.spentTokens, 7);
  lease.assertOwned();
  lease.release();
});

test(
  "independent processes sharing SQLite cannot claim or write a live owner's journal",
  { timeout: 30_000 },
  async (t) => {
    const children: ChildProcess[] = [];
    const f = await fixture(t, async () => {
      for (const child of children) {
        if (child.exitCode !== null) continue;
        const exited = once(child, "exit");
        child.disconnect();
        await exited;
      }
    });
    async function start() {
      const child = fork(new URL("./workflow-owner.fixture.ts", import.meta.url), [f.path], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      await once(child, "message");
      return child;
    }
    async function request(child: ChildProcess, action: string) {
      const reply = once(child, "message");
      child.send({ action });
      return (await reply)[0] as { ok: boolean; code?: string; generation?: number };
    }
    const first = await start();
    assert.equal((await request(first, "claim")).ok, true);
    f.journal.createRun(run());
    const second = await start();
    assert.deepEqual(await request(second, "claim"), { ok: false, code: "owner_active" });
    assert.equal(f.journal.getRun("live")?.status, "running");
    assert.equal((await request(first, "release")).ok, true);
    const third = await start();
    const claims = await Promise.all([request(second, "claim"), request(third, "claim")]);
    assert.equal(claims.filter((claim) => claim.ok).length, 1);
    assert.equal(claims.find((claim) => claim.ok)?.generation, 2);
    assert.ok(
      ["owner_active", "owner_changed"].includes(claims.find((claim) => !claim.ok)?.code ?? ""),
    );
    const winner = claims[0]!.ok ? second : third;
    assert.deepEqual(await request(first, "write"), { ok: false, code: "owner_changed" });
    assert.equal((await request(winner, "write")).ok, true);
    assert.equal(f.journal.getRun("live")?.spentTokens, 7);
    await request(winner, "release");
  },
);
