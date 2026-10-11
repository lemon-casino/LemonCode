import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import { queryProviderUsage } from "./repositories/provider-usage-query.js";

const DAY_MS = 86_400_000;
const end = Date.UTC(2026, 9, 11, 18);
const connections = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "create table schema_migration(id text primary key, checksum text not null, app_version text not null, time_applied integer not null)",
  );
  for (const migration of SQLITE_MIGRATIONS) db.exec(migration.sql);
  for (const session of ["a", "b"])
    db.prepare(
      "insert into session(id,project_id,slug,directory,title,version,time_created,time_updated) values(?,'project',?,'fixture','fixture','1',1000,1000)",
    ).run(session, session);
  for (const [session, turn, duration, status] of [
    ["a", "a1", 60000, "completed"],
    ["a", "a2", 120000, "completed"],
    ["b", "b1", 90000, "completed"],
    ["b", "b2", 50000, "error"],
    ["b", "api", 900000, "completed"],
  ] as const)
    db.prepare(
      "insert into turn_usage(session_id,turn_id,status,started_at,duration_ms) values(?,?,?,1000,?)",
    ).run(session, turn, status, duration);
  const insert = db.prepare(
    "insert into model_usage(id,logical_request_id,session_id,turn_id,query_source,provider_id,auth_channel_id,account_connection_id,model_id,status,started_at,input_tokens,output_tokens,computed_total_tokens,usage_known) values(?,?,?,?,'main_turn',?,?,?,?,?,?,?,?,?,?)",
  );
  for (const [id, session, turn, channel, account, model, day, tokens] of [
    ["one", "a", "a1", "codex", 0, "shared", 7, 120],
    ["two", "a", "a1", "codex", 0, "shared", 7, 30],
    ["three", "a", "a2", "codex", 0, "shared", 9, 50],
    ["four", "a", "a2", "zai", 1, "shared", 9, 70],
    ["five", "b", "b1", "zai", 1, "other", 10, 30],
    ["removed", "b", "b2", "antigravity", 2, "shared", 11, null],
    ["api", "b", "api", "api", 0, "shared", 11, 9000],
  ] as const)
    insert.run(
      id,
      id,
      session,
      turn,
      channel === "api" ? "custom-api" : `oauth:${channel}`,
      channel === "api" ? null : channel,
      channel === "api" ? null : connections[account]!,
      model,
      tokens === null ? "error" : "completed",
      Date.UTC(2026, 9, day, 12),
      tokens ?? 0,
      0,
      tokens ?? 0,
      tokens === null ? 0 : 1,
    );
  return db;
}

test("OAuth lifetime overview isolates API, counts a mixed turn once and retains deleted identities", async () => {
  const db = fixture();
  try {
    const all = await queryProviderUsage(db, {
      range: "all",
      since: 0,
      until: end,
      timeZone: "UTC",
    });
    assert.equal(all.summary.totalTokens, 300);
    assert.equal(all.summary.requestCount, 6);
    assert.equal(all.activity?.peakDayTokens, 150);
    assert.equal(all.activity?.longestSessionMs, 180000);
    assert.equal(all.activity?.currentStreakDays, 0);
    assert.equal(all.activity?.longestStreakDays, 2);
    assert.equal(all.activity?.activeDays, 3);
    assert.equal(
      all.providers.find((row) => row.providerId === "oauth:antigravity")?.errorCount,
      1,
    );
    assert.equal(
      all.accounts.find((row) => row.accountConnectionId === connections[2])?.requestCount,
      1,
    );
    const date = all.dailyModels?.filter(
      (row) => row.date === "2026-10-09" && row.modelId === "shared",
    );
    assert.deepEqual(date?.map((row) => [row.providerId, row.totalTokens]).sort(), [
      ["oauth:codex", 50],
      ["oauth:zai", 70],
    ]);
    assert.equal(all.daily.find((row) => row.date === "2026-10-11")?.knownUsageRequests, 0);
    const account = await queryProviderUsage(db, {
      range: "all",
      since: 0,
      until: end,
      connectionId: connections[1],
      timeZone: "UTC",
    });
    assert.equal(account.summary.totalTokens, 100);
    assert.equal(account.activity?.longestSessionMs, 120000);
    const range = await queryProviderUsage(db, {
      range: "24h",
      since: end - DAY_MS,
      until: end,
      timeZone: "UTC",
    });
    assert.equal(range.summary.totalTokens, 0);
    assert.equal(range.summary.requestCount, 1);
    const yesterday = await queryProviderUsage(db, {
      range: "all",
      since: 0,
      until: end - DAY_MS,
      timeZone: "UTC",
    });
    assert.equal(yesterday.activity?.currentStreakDays, 2);
  } finally {
    db.close();
  }
});

test("OAuth overview uses IANA calendar days across DST and distinguishes unknown duration from real zero", async () => {
  const db = fixture();
  try {
    db.exec("delete from model_usage; delete from turn_usage;");
    const now = Date.UTC(2026, 2, 9, 12);
    const insert = db.prepare(
      "insert into model_usage(id,logical_request_id,session_id,query_source,provider_id,model_id,status,started_at,input_tokens,output_tokens,computed_total_tokens,usage_known) values(?,?,'a','main_turn','oauth:codex','shared','completed',?,1,0,1,1)",
    );
    for (const [id, time] of [
      ["before", Date.UTC(2026, 2, 8, 7, 30)],
      ["after", Date.UTC(2026, 2, 9, 6, 30)],
      ["today", Date.UTC(2026, 2, 9, 8, 30)],
    ] as const)
      insert.run(id, id, time);
    const value = await queryProviderUsage(db, {
      range: "all",
      since: 0,
      until: now,
      timeZone: "America/Los_Angeles",
    });
    assert.equal(value.activity?.longestStreakDays, 3);
    assert.equal(value.activity?.currentStreakDays, 3);
    assert.equal(value.activity?.longestSessionMs, null);
    db.exec("update model_usage set input_tokens=0, computed_total_tokens=0;");
    const zero = await queryProviderUsage(db, { range: "all", since: 0, until: now });
    assert.equal(zero.summary.knownUsageRequests, 3);
    assert.equal(zero.activity?.peakDayTokens, 0);
    assert.equal(zero.activity?.activeDays, 0);
  } finally {
    db.close();
  }
});

test("lifetime daily output is bounded without losing retained totals or inventing legacy metrics", async () => {
  const db = fixture();
  try {
    db.prepare("update model_usage set started_at=? where id='one'").run(Date.UTC(2020, 0, 1));
    const snapshot = await queryProviderUsage(db, { range: "all", since: 0, until: end });
    assert.equal(snapshot.summary.totalTokens, 300);
    assert.ok(snapshot.daily.length <= 366);
    assert.equal(snapshot.daily.at(-1)?.date, "2026-10-11");
    assert.equal(snapshot.activity?.dailyTruncated, true);
    const { activity: _activity, dailyModels: _models, ...legacy } = snapshot;
    const { providerUsageSnapshotSchema } = await import("@lcode/shared");
    const parsed = providerUsageSnapshotSchema.parse(legacy);
    assert.equal(parsed.activity, undefined);
    assert.equal(parsed.dailyModels, undefined);
  } finally {
    db.close();
  }
});
