import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import { queryAppUsage } from "./repositories/usage-query.js";
import { lcodeUsageStatsParamsSchema } from "@lcode/shared";
import { v4UsageStatsParamsSchema } from "@lcode/shared/lcode-protocol-v4";

test("API usage excludes OAuth, legacy account plans and unknown connection history from every aggregate", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "create table schema_migration(id text primary key, checksum text not null, app_version text not null, time_applied integer not null)",
    );
    for (const migration of SQLITE_MIGRATIONS) db.exec(migration.sql);
    db.exec(
      "insert into session(id,project_id,slug,directory,title,version,time_created,time_updated) values('session','project','fixture','fixture','fixture','1',1000,1000)",
    );
    const insert = db.prepare(
      `insert into model_usage(id,logical_request_id,session_id,turn_id,query_source,provider_id,model_id,status,started_at,input_tokens,output_tokens,computed_total_tokens,auth_channel_id) values(?,?,'session',?,'main_turn',?,?,'completed',1000,?,2,?,?)`,
    );
    for (const [id, provider, channel, tokens] of [
      ["api", "custom-api", null, 10],
      ["oauth", "oauth:codex", "codex", 20],
      ["old-oauth", "oauth:antigravity", null, 30],
      ["plan", "account:zai-start-plan", null, 40],
      ["unknown", "", null, 50],
      ["old-plan", "builtin:zai-coding-plan", null, 60],
      ["mixed-api", "custom-api", null, 5],
      ["mixed-oauth", "oauth:codex", "codex", 90],
    ] as const)
      insert.run(
        id,
        id,
        id.startsWith("mixed") ? "mixed" : id,
        provider,
        id,
        tokens,
        tokens + 2,
        channel,
      );
    for (const id of ["api", "oauth", "old-oauth", "plan", "unknown", "old-plan", "mixed"]) {
      db.prepare(
        "insert into turn_usage(session_id,turn_id,status,started_at,duration_ms) values('session',?,'completed',1000,100)",
      ).run(id);
      db.prepare(
        "insert into tool_usage(id,tool_call_id,session_id,turn_id,tool_name,status,started_at,duration_ms) values(?,?,'session',?,?,'completed',1000,10)",
      ).run(id, id, id, id);
    }
    const input = { since: 0, until: 2000, tzOffsetMs: 0 };
    const api = await queryAppUsage(db, { ...input, connectionType: "api-key" });
    assert.equal(api.totals.modelRequestCount, 2);
    assert.equal(api.totals.totalTokens, 19);
    assert.deepEqual(api.models.map((row) => row.modelId).sort(), ["api", "mixed-api"]);
    assert.equal(api.turnTotals.totalTurns, 2);
    assert.equal(api.turnTotals.totalSessions, 1);
    assert.equal(api.toolTotals.toolCallCount, 2);
    assert.deepEqual(api.tools.map((row) => row.toolName).sort(), ["api", "mixed"]);
    assert.equal(api.days[0]?.totalTokens, 19);
    assert.equal(api.days[0]?.turnCount, 2);
    assert.equal(api.days[0]?.toolCallCount, 2);
    assert.equal(
      api.dayModels.reduce((sum, row) => sum + row.totalTokens, 0),
      19,
    );
    const all = await queryAppUsage(db, input);
    assert.equal(all.totals.modelRequestCount, 8);
    assert.equal(all.turnTotals.totalTurns, 7);
    assert.equal(all.toolTotals.toolCallCount, 7);
  } finally {
    db.close();
  }
});

test("V4 and legacy usage query contracts keep the optional API connection filter", () => {
  const input = { range: "7d", connectionType: "api-key" };
  for (const schema of [lcodeUsageStatsParamsSchema, v4UsageStatsParamsSchema]) {
    assert.deepEqual(schema.parse(input), input);
    assert.throws(() => schema.parse({ ...input, connectionType: "unknown" }));
    assert.deepEqual(schema.parse({ range: "7d" }), { range: "7d" });
  }
});
