import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL } from "../migrations/0023-dwf-actor-model-provenance.js";
import { createDwfJournalStore } from "./dwf-journal.js";

test("SQLite persists actor model selection and provenance atomically", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table dwf_run (id text primary key);
      create table dwf_actor (
        id integer primary key autoincrement,
        run_id text not null references dwf_run(id) on delete cascade,
        site_id text not null,
        ordinal integer not null,
        name text,
        persona_json text,
        resolved_model text,
        session_id text,
        time_created integer not null,
        time_updated integer not null,
        unique(run_id, site_id, ordinal)
      );
      insert into dwf_run (id) values ('run-1');
    `);
    db.exec(DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL);
    const journal = createDwfJournalStore(db);
    journal.putActor({
      runId: "run-1",
      siteId: "actor#1",
      ordinal: 1,
      resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
      modelProvenance: "sessionInherited",
    });
    assert.deepEqual(journal.getActor("run-1", "actor#1", 1), {
      runId: "run-1",
      siteId: "actor#1",
      ordinal: 1,
      resolvedModel: 'selection:{"providerId":"provider-a","modelId":"model-a"}',
      modelProvenance: "sessionInherited",
    });

    db.exec(`
      create trigger reject_actor_binding_update before update on dwf_actor
      when new.resolved_model like '%provider-b%'
      begin
        select raise(abort, 'binding write failed');
      end;
    `);
    assert.throws(
      () =>
        journal.putActor({
          runId: "run-1",
          siteId: "actor#1",
          ordinal: 1,
          resolvedModel: 'selection:{"providerId":"provider-b","modelId":"model-b"}',
          modelProvenance: "resumePin",
        }),
      /binding write failed/,
    );
    assert.equal(journal.getActor("run-1", "actor#1", 1)?.modelProvenance, "sessionInherited");
    assert.match(journal.getActor("run-1", "actor#1", 1)?.resolvedModel ?? "", /provider-a/);
  } finally {
    db.close();
  }
});

test("the provenance column rejects unknown values while accepting legacy NULL", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table dwf_actor (
        id integer primary key,
        run_id text not null,
        site_id text not null,
        ordinal integer not null,
        resolved_model text
      );
    `);
    db.exec(DWF_ACTOR_MODEL_PROVENANCE_MIGRATION_SQL);
    db.prepare(
      "insert into dwf_actor (id, run_id, site_id, ordinal, model_provenance) values (?, ?, ?, ?, ?)",
    ).run(1, "legacy", "actor#1", 1, null);
    assert.throws(
      () =>
        db
          .prepare(
            "insert into dwf_actor (id, run_id, site_id, ordinal, model_provenance) values (?, ?, ?, ?, ?)",
          )
          .run(2, "bad", "actor#2", 1, "guessedPin"),
      /CHECK constraint failed/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            "insert into dwf_actor (id, run_id, site_id, ordinal, model_provenance) values (?, ?, ?, ?, ?)",
          )
          .run(3, "unpaired", "actor#3", 1, "resumePin"),
      /CHECK constraint failed/,
    );
  } finally {
    db.close();
  }
});
