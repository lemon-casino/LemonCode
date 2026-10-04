import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskIndexRepo } from "./taskIndexRepo.js";
import { runTasksDatabaseMigrations } from "./tasksDatabase/migrations.js";

test("upgrade adds permanent deletion markers without changing historical migration checksums", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runTasksDatabaseMigrations(db);
    const prior = db
      .prepare(
        "SELECT id,checksum FROM tasks_schema_migration WHERE id <> '0004_task_history_deletions' ORDER BY id",
      )
      .all();
    db.exec(
      "DROP TABLE task_history_deletions; DELETE FROM tasks_schema_migration WHERE id='0004_task_history_deletions'",
    );
    runTasksDatabaseMigrations(db);
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,checksum FROM tasks_schema_migration WHERE id <> '0004_task_history_deletions' ORDER BY id",
        )
        .all(),
      prior,
    );
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_history_deletions'").get());
  } finally {
    db.close();
  }
});

test("permanent deletion clears content projections and keeps identity-specific tombstones", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-task-purge-"));
  const dbPath = join(root, "tasks.sqlite");
  const repo = new TaskIndexRepo(dbPath);
  const scope = { taskId: "chat", workspacePath: "/origin" };
  try {
    await repo.seedTaskMetaIfMissing({
      ...scope,
      traceId: "test",
      title: "private title",
      mode: "edit",
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.seedTaskMetaIfMissing({
      ...scope,
      workspaceIdentity: "remote-other",
      traceId: "test",
      title: "remote title",
      mode: "edit",
      createdAt: 1,
      updatedAt: 1,
    });
    const meta = await repo.purgeTaskHistory(scope);
    assert.equal(meta.title, "");
    await repo.purgeTaskHistory(scope);
    await repo.purgeTaskHistory({ ...scope, taskId: "missing" });
    await repo.syncTaskMeta({
      meta: {
        ...scope,
        traceId: "stale",
        title: "private title from stale stream",
        mode: "edit",
        createdAt: 1,
        updatedAt: Date.now(),
      },
      deleted: false,
      searchableText: "private transcript",
    });
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare(
          "select workspace_key, title, meta_json, searchable_text, deleted from tasks where task_id = ?",
        )
        .all("chat") as {
        workspace_key: string;
        title: string;
        meta_json: string;
        searchable_text: string;
        deleted: number;
      }[];
      const local = rows.find((row) => row.workspace_key === "/origin")!;
      assert.equal(local.deleted, 1);
      assert.equal(local.searchable_text, "");
      assert.doesNotMatch(local.meta_json, /private title/);
      assert.equal(rows.find((row) => row.workspace_key === "remote-other")?.deleted, 0);
    } finally {
      db.close();
    }
  } finally {
    repo.close();
    await rm(root, { recursive: true, force: true });
  }
});
