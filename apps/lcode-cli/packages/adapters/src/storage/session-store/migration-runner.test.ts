import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrationsAsync,
} from "./migration-runner.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";

const restoreTimeoutSql = `pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`;
const primaryFailures = [new Error("notification failed"), null, undefined, 0, false, ""];

for (const [index, primaryFailure] of primaryFailures.entries()) {
  test(`migration cleanup preserves primary failure ${index}, including falsy values`, async (t) => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    const exec = db.exec.bind(db);
    const commands: string[] = [];
    t.mock.method(db, "exec", (sql: string) => {
      commands.push(sql);
      if (sql === restoreTimeoutSql) throw new Error("timeout restoration failed");
      exec(sql);
    });

    const outcome = await runSqliteSessionMigrationsAsync(db, ":memory:", {
      async onProgress(progress) {
        if (progress.phase === "migrating") throw primaryFailure;
      },
    }).then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );

    assert.equal(outcome.rejected, true);
    assert.equal(outcome.error, primaryFailure);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(commands.slice(-2), ["rollback", restoreTimeoutSql]);
    assert.equal(
      db.prepare("select name from sqlite_master where name = 'schema_migration'").get(),
      undefined,
    );
  });
}

test("migration timeout restoration is attempted even if generator cleanup fails", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const iterator = (function* () {
    yield undefined;
  })();
  const generatorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(iterator)) as {
    return: (this: Generator, value?: unknown) => IteratorResult<unknown>;
  };
  const originalReturn = generatorPrototype.return;
  const primaryFailure = new Error("progress transport failed");
  const cleanupFailure = new Error("generator cleanup failed");
  let cleanupAttempts = 0;
  t.mock.method(generatorPrototype, "return", function (this: Generator, value?: unknown) {
    cleanupAttempts += 1;
    originalReturn.call(this, value);
    throw cleanupFailure;
  });

  await assert.rejects(
    runSqliteSessionMigrationsAsync(db, ":memory:", {
      async onProgress() {
        throw primaryFailure;
      },
    }),
    (error: unknown) => error === primaryFailure,
  );

  assert.ok(cleanupAttempts > 0);
  assert.equal(
    db.prepare("pragma busy_timeout").get()?.timeout,
    DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  );
});

test("successful migration surfaces cleanup failure without undoing committed SQL", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const exec = db.exec.bind(db);
  const cleanupFailure = new Error("timeout restoration failed");
  t.mock.method(db, "exec", (sql: string) => {
    if (sql === restoreTimeoutSql) throw cleanupFailure;
    exec(sql);
  });

  await assert.rejects(
    runSqliteSessionMigrationsAsync(db, ":memory:"),
    (error: unknown) => error === cleanupFailure,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("select count(*) as count from schema_migration").get()?.count, 23);
});

test("both cleanup steps are attempted and first falsy cleanup failure wins", async (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const iterator = (function* () {
    yield undefined;
  })();
  const generatorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(iterator)) as {
    return: (this: Generator, value?: unknown) => IteratorResult<unknown>;
  };
  const originalReturn = generatorPrototype.return;
  t.mock.method(generatorPrototype, "return", function (this: Generator, value?: unknown) {
    originalReturn.call(this, value);
    throw undefined;
  });
  const exec = db.exec.bind(db);
  let restoreAttempted = false;
  t.mock.method(db, "exec", (sql: string) => {
    if (sql === restoreTimeoutSql) {
      restoreAttempted = true;
      throw new Error("second cleanup failure");
    }
    exec(sql);
  });
  const outcome = await runSqliteSessionMigrationsAsync(db, ":memory:").then(
    () => ({ rejected: false, error: undefined }),
    (error: unknown) => ({ rejected: true, error }),
  );
  assert.equal(outcome.rejected, true);
  assert.equal(outcome.error, undefined);
  assert.equal(restoreAttempted, true);
  assert.equal(db.isTransaction, false);
});

test("startup closes rejected connections and can retry with a fresh owner", async (t) => {
  const close = DatabaseSync.prototype.close;
  let closeCount = 0;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    closeCount += 1;
    close.call(this);
  });
  const primaryFailure = new Error("startup transport failed");
  await assert.rejects(
    SqliteSessionStore.openStartup(
      { dbPath: ":memory:" },
      {
        async onProgress(progress) {
          if (progress.phase === "migrating") throw primaryFailure;
        },
      },
    ),
    (error: unknown) => error === primaryFailure,
  );
  assert.equal(closeCount, 1);

  const store = await SqliteSessionStore.openStartup({ dbPath: ":memory:" });
  try {
    assert.equal(store.debugMigrationIds().length, 23);
  } finally {
    store.close();
  }
  assert.equal(closeCount, 2);
});
