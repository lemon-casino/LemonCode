import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import { OAUTH_USAGE_MIGRATION_SQL } from "./migrations/0025-oauth-usage.js";
import { queryProviderUsage } from "./repositories/provider-usage-query.js";
import type { ModelUsageRecord, ProjectId, SessionId } from "@lcode/contracts";
import { providerUsageSnapshotSchema } from "@lcode/shared";
import { createSqliteSessionStore } from "../session-store.js";

test("an existing database upgrades without inventing account attribution or losing old usage", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `create table schema_migration(id text primary key, checksum text not null, app_version text not null, time_applied integer not null)`,
    );
    for (const migration of SQLITE_MIGRATIONS.filter((item) => item.id !== "0025_oauth_usage"))
      db.exec(migration.sql);
    const now = Date.now();
    db.prepare(`insert into session(id, project_id, slug, directory, title, version, time_created, time_updated)
      values ('legacy', 'project', 'legacy', 'fixture', 'legacy', '1', ?, ?)`).run(now, now);
    db.prepare(`insert into model_usage(id, logical_request_id, session_id, query_source, provider_id,
      model_id, status, started_at, input_tokens, output_tokens, computed_total_tokens)
      values (?, ?, 'legacy', 'main_turn', 'oauth:codex', 'model', 'completed', ?, ?, ?, ?)`).run(
      "known",
      "known",
      now,
      10,
      2,
      12,
    );
    db.prepare(`insert into model_usage(id, logical_request_id, session_id, query_source, provider_id,
      model_id, status, started_at) values ('unknown', 'unknown', 'legacy', 'main_turn', 'oauth:codex', 'model', 'error', ?)`).run(
      now,
    );
    db.exec(OAUTH_USAGE_MIGRATION_SQL);
    const result = await queryProviderUsage(db, {
      range: "7d",
      since: now - 1000,
      until: now,
      connectionId: null,
    });
    assert.equal(result.summary.requestCount, 2);
    assert.equal(result.summary.totalTokens, 12);
    assert.equal(result.summary.knownUsageRequests, 1);
    assert.equal(result.accounts[0]!.accountConnectionId, null);
    assert.equal(result.accounts[0]!.authChannelId, "codex");
  } finally {
    db.close();
  }
});

async function fixture() {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = "usage-accounts" as SessionId;
  await store.createSession({
    id: sessionID,
    projectID: "project" as ProjectId,
    directory: "fixture",
    slug: "usage",
    title: "usage",
    version: "1",
  });
  const now = Date.now();
  const base: ModelUsageRecord = {
    id: "one",
    logicalRequestId: "one",
    sessionID,
    querySource: "main_turn",
    providerId: "oauth:bigmodel",
    authChannelId: "bigmodel",
    modelId: "same-model",
    status: "completed",
    startedAt: now - 1000,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 60,
    reasoningTokens: 5,
    durationMs: 2000,
    timeToFirstTokenMs: 100,
    usageKnown: true,
  };
  const query = {
    range: "7d" as const,
    timeZone: "Asia/Shanghai",
    since: now - 7 * 86400000,
    until: now,
  };
  return { store, base, query };
}

test("OAuth accounting preserves final account, normalized tokens, unknown usage and API isolation", async () => {
  const { store, base, query } = await fixture();
  const connectionId = randomUUID();
  try {
    await store.recordModelUsage({ ...base, accountConnectionId: connectionId, retryCount: 1 });
    await store.recordModelUsage({ ...base, accountConnectionId: connectionId, retryCount: 1 });
    await store.recordModelUsage({
      ...base,
      id: "unknown",
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadInputTokens: undefined,
      reasoningTokens: undefined,
      usageKnown: false,
      status: "error",
      errorCode: "private-token-must-not-appear",
    });
    await store.recordModelUsage({
      ...base,
      id: "api",
      providerId: "custom-api",
      authChannelId: undefined,
    });
    const result = providerUsageSnapshotSchema.parse(await store.queryProviderUsage(query));
    assert.equal(result.summary.requestCount, 2);
    assert.equal(result.summary.knownUsageRequests, 1);
    assert.equal(result.summary.totalTokens, 120);
    assert.equal(result.summary.cacheHitRate, 0.6);
    assert.equal(result.summary.retryCount, 1);
    assert.equal(result.accounts.length, 2);
    assert.equal(result.requests.find((row) => row.id === "unknown")!.totalTokens, null);
    assert.equal(JSON.stringify(result).includes("private-token"), false);
    const account = await store.queryProviderUsage({ ...query, connectionId });
    assert.equal(account.summary.requestCount, 1);
    assert.equal(account.accounts[0]!.accountConnectionId, connectionId);
    const unknown = await store.queryProviderUsage({ ...query, connectionId: null });
    assert.equal(unknown.summary.errorCount, 1);
    const app = await store.queryAppUsage({
      since: query.since,
      until: query.until,
      tzOffsetMs: 0,
    });
    assert.equal(app.totals.modelRequestCount, 3);
    assert.equal(app.totals.totalTokens, 240);
  } finally {
    store.close();
  }
});

test("provider/model filters apply to every aggregate and pagination is stable", async () => {
  const { store, base, query } = await fixture();
  try {
    for (const [id, providerId] of [
      ["a", "oauth:bigmodel"],
      ["b", "oauth:codex"],
      ["c", "oauth:bigmodel"],
    ])
      await store.recordModelUsage({
        ...base,
        id,
        providerId,
        authChannelId: providerId.slice(6),
        accountConnectionId: randomUUID(),
      });
    const result = await store.queryProviderUsage({
      ...query,
      providerId: "oauth:bigmodel",
      modelId: "same-model",
      limit: 1,
      offset: 1,
    });
    assert.equal(result.summary.requestCount, 2);
    assert.equal(result.totalRequests, 2);
    assert.equal(result.requests.length, 1);
    assert.equal(result.providers.length, 1);
    assert.equal(result.models.length, 1);
    assert.equal(
      result.daily.reduce((sum, day) => sum + day.requestCount, 0),
      2,
    );
    const injection = await store.queryProviderUsage({
      ...query,
      providerId: "oauth:bigmodel' OR 1=1 --",
    });
    assert.equal(injection.summary.requestCount, 0);
    assert.equal(injection.summary.cacheHitRate, null);
    assert.equal(injection.summary.avgDurationMs, null);
  } finally {
    store.close();
  }
});

test("calendar buckets honor caller timezone and retention does not create historical zeros", async () => {
  const { store, base, query } = await fixture();
  try {
    const midnight = Math.floor(query.until / 86400000) * 86400000;
    await store.recordModelUsage({ ...base, startedAt: midnight - 3600000 });
    const china = await store.queryProviderUsage(query);
    const pacific = await store.queryProviderUsage({ ...query, timeZone: "America/Los_Angeles" });
    assert.notEqual(
      china.daily.find((day) => day.requestCount)!.date,
      pacific.daily.find((day) => day.requestCount)!.date,
    );
    assert.equal(china.retentionDays, 30);
    assert.ok(china.daily.length <= 8);
    await assert.rejects(store.queryProviderUsage({ ...query, timeZone: "invalid/timezone" }));
  } finally {
    store.close();
  }
});
