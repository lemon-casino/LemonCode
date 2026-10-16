import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderAccountQuota, ProviderAccountQuotaWindow } from "@lcode/shared";
import { ProviderAccountScheduler } from "./providerAccountScheduler.js";

const routes = ["a", "b"].map((connectionId) => ({
  account: { connectionId, generation: 1, channelId: "fixture" },
  model: {
    id: "model",
    name: "Model",
    protocol: "openai-chat-completions" as const,
    baseURL: "https://fixture.invalid/v1",
  },
}));
const invocation = (attemptId: string) => ({
  capability: "single-attempt-routing-v1" as const,
  workspaceKey: "workspace",
  sessionId: "session",
  attemptId,
  turnId: attemptId,
});
function owner(windows: (id: string) => ProviderAccountQuotaWindow[]) {
  return new ProviderAccountScheduler(async () => ({ version: 1, strategy: "headroom-balance" }), {
    peek: (id) => ({
      revision: 1,
      value: {
        connectionId: id,
        source: "upstream",
        status: "ready",
        stale: false,
        windows: windows(id),
      } satisfies ProviderAccountQuota,
    }),
  });
}
const window = (
  id: string,
  remaining: number,
  extra: Partial<ProviderAccountQuotaWindow> = {},
): ProviderAccountQuotaWindow => ({
  id,
  name: id,
  remaining,
  limit: 100,
  unit: "requests",
  kind: "budget",
  stableId: true,
  ...extra,
});
const request = () =>
  new Request("https://oauth.invalid/v1/chat/completions", {
    method: "POST",
    body: '{"model":"model"}',
  });

test("original quota cache projects short and weekly windows as an intersection", async () => {
  const scheduler = owner((id) => [window("short", id === "a" ? 0 : 20), window("weekly", 90)]);
  const selected = await scheduler.reserve("fixture", routes, request(), invocation("one"));
  assert.equal(selected!.lease.routeId, "b");
  selected!.lease.cancel();
  scheduler.dispose();
});

test("shared organization metadata prevents two accounts reserving the last request", async () => {
  const scheduler = owner(() => [
    window("weekly", 1, {
      scope: "organization",
      quotaPoolId: "fixture-team",
      instanceId: "period-1",
    }),
  ]);
  const first = await scheduler.reserve("fixture", routes, request(), invocation("one"));
  await assert.rejects(
    scheduler.reserve("fixture", routes, request(), invocation("two")),
    /quota-exhausted/,
  );
  const diagnostic = scheduler.readDiagnostics("fixture")!;
  assert.equal(diagnostic.owner.resources.length, 1);
  assert.equal(diagnostic.owner.resources[0]!.readingRemaining, 1);
  assert.equal(diagnostic.owner.resources[0]!.reserved, 1);
  assert.equal(diagnostic.owner.resources[0]!.available, 0);
  const repeated = scheduler.readDiagnostics("fixture")!;
  assert.deepEqual(
    { ...repeated, asOf: 0, owner: { ...repeated.owner, asOf: 0 } },
    { ...diagnostic, asOf: 0, owner: { ...diagnostic.owner, asOf: 0 } },
  );
  first!.lease.cancel();
  scheduler.dispose();
});

test("display pool labels never merge account balances, and excluded models win", async () => {
  const scheduler = owner(() => [
    window("weekly", 1, { pool: "Same display label" }),
    window("other-model", 0, { includedModelIds: ["model"], excludedModelIds: ["model"] }),
  ]);
  const first = await scheduler.reserve("fixture", routes, request(), invocation("one"));
  const second = await scheduler.reserve("fixture", routes, request(), invocation("two"));
  assert.notEqual(first!.lease.routeId, second!.lease.routeId);
  first!.lease.cancel();
  second!.lease.cancel();
  scheduler.dispose();
});

test("rolling reset hints cannot manufacture new quota instances during refresh", async () => {
  let resetAt = new Date(Date.now() + 60_000).toISOString();
  const scheduler = owner(() => [window("short", 1, { resetMode: "rolling", resetAt })]);
  const first = await scheduler.reserve(
    "fixture",
    routes.slice(0, 1),
    request(),
    invocation("one"),
  );
  first!.lease.dispatch();
  first!.finish(routes[0]!.account, new Response("ok"), true);
  resetAt = new Date(Date.now() + 120_000).toISOString();
  await assert.rejects(
    scheduler.reserve("fixture", routes.slice(0, 1), request(), invocation("two")),
    /quota-exhausted/,
  );
  scheduler.dispose();
});

test("an explicitly shared cooldown cannot be bypassed by selecting another account", async () => {
  const scheduler = owner(() => []);
  const first = await scheduler.reserve("fixture", routes, request(), invocation("one"));
  first!.lease.dispatch();
  first!.finish(
    routes[0]!.account,
    new Response("limited", {
      status: 429,
      headers: { "x-lcode-rate-limit-scope": "shared", "retry-after": "120" },
    }),
  );
  await assert.rejects(
    scheduler.reserve("fixture", routes.slice(1), request(), invocation("two")),
    /route-cooling/,
  );
  scheduler.dispose();
});

test("model-scoped rejection does not mark an account's other models as exhausted", async () => {
  const scheduler = owner(() => []);
  const first = await scheduler.reserve(
    "fixture",
    routes.slice(0, 1),
    request(),
    invocation("one"),
  );
  first!.lease.dispatch();
  // 模型隔离需要驱动确认的局部限流；未知 scope 的 429 现按 provider 保守处理。
  first!.finish(
    routes[0]!.account,
    new Response("limited", { status: 429, headers: { "x-lcode-rate-limit-scope": "key" } }),
  );
  const other = [
    { account: routes[0]!.account, model: { ...routes[0]!.model, id: "other-model" } },
  ];
  const next = await scheduler.reserve("fixture", other, request(), invocation("two"));
  assert.equal(next!.lease.routeId, "a");
  next!.lease.cancel();
  scheduler.dispose();
});

test("fresh credentials clear only their auth rejection and cannot erase quota debits", async () => {
  const scheduler = owner(() => [window("weekly", 1)]);
  const original = routes.slice(0, 1);
  const first = (await scheduler.reserve("fixture", original, request(), invocation("old")))!;
  first.lease.dispatch();
  first.finish(original[0]!.account, new Response(null, { status: 401 }));
  const refreshed = [{ ...original[0]!, account: { ...original[0]!.account, generation: 2 } }];
  await assert.rejects(
    scheduler.reserve("fixture", refreshed, request(), invocation("new")),
    /quota-exhausted/,
  );
  scheduler.dispose();
});

test("expired auth quarantine cannot hide a model cooldown after credential refresh", async () => {
  const scheduler = owner(() => []);
  const original = routes.slice(0, 1);
  const first = (await scheduler.reserve("fixture", original, request(), invocation("old")))!;
  first.lease.dispatch();
  first.finish(original[0]!.account, new Response(null, { status: 401 }));
  const refreshed = [{ ...original[0]!, account: { ...original[0]!.account, generation: 2 } }];
  const next = (await scheduler.reserve("fixture", refreshed, request(), invocation("new")))!;
  next.lease.dispatch();
  next.finish(
    refreshed[0]!.account,
    new Response(null, { status: 429, headers: { "retry-after": "120" } }),
  );
  const again = [{ ...refreshed[0]!, account: { ...refreshed[0]!.account, generation: 3 } }];
  await assert.rejects(
    scheduler.reserve("fixture", again, request(), invocation("again")),
    /route-cooling/,
  );
  scheduler.dispose();
});
