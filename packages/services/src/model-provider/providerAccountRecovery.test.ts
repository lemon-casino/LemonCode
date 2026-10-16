import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAccountScheduler } from "./providerAccountScheduler.js";
import type { ProviderAccountQuotas } from "./providerAccountQuotas.js";
import type { RoutingInvocation } from "@lcode/shared";

test("RCD-05 OAuth unknown 429 scope blocks the provider and a physical network failure cools the selected model", async () => {
  let now = 0;
  const owner = new ProviderAccountScheduler(
    async () => ({ version: 1, strategy: "primary-backup" }),
    { peek: () => undefined } as unknown as ProviderAccountQuotas,
    { now: () => now },
  );
  const routes = ["a", "b"].map((connectionId) => ({
    account: { connectionId, channelId: "fixture", generation: 1 },
    model: {
      id: "model",
      name: "Model",
      protocol: "openai-chat-completions" as const,
      baseURL: "https://fixture.invalid",
      routingPortability: "portable" as const,
    },
  }));
  const reserve = (id: string) =>
    owner.reserve("fixture", routes, new Request("https://fixture.invalid"), {
      capability: "single-attempt-routing-v1",
      workspaceKey: "workspace",
      sessionId: "session",
      turnId: id,
      attemptId: id,
    });
  const initial = (await reserve("rate"))!;
  initial.lease.dispatch();
  initial.finish(
    routes[0]!.account,
    new Response("rate", { status: 429, headers: { "retry-after-ms": "1000" } }),
    false,
  );
  await assert.rejects(reserve("blocked"), /route-cooling/);
  assert.equal(
    owner.readDiagnostics("fixture")!.recovery[0]!.resource,
    JSON.stringify(["provider", "fixture"]),
  );
  now = 1000;
  const probe = (await reserve("probe"))!;
  probe.lease.dispatch();
  probe.finish(routes[0]!.account, undefined, false);
  await assert.rejects(reserve("network-cooled"), /route-cooling/);
  assert.equal(owner.readDiagnostics("fixture")!.recovery[0]!.phase, "cooling");
  owner.dispose();
});

for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  test(`RCD-05 OAuth ${protocol} has one recovery probe and does not recover from HTTP 200 alone`, async () => {
    let now = 0;
    const quota = {
      peek: () => ({
        revision: 1,
        value: {
          windows: [
            {
              id: "requests",
              unit: "requests",
              remaining: 100,
              limit: 100,
              kind: "rate",
              stableId: true,
              instanceId: "one",
            },
          ],
        },
      }),
    } as unknown as ProviderAccountQuotas;
    const owner = new ProviderAccountScheduler(
      async () => ({ version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 }),
      quota,
      { now: () => now },
    );
    const routes = ["a", "b"].map((connectionId) => ({
      account: { connectionId, channelId: "fixture", generation: 1 },
      model: {
        id: "model",
        name: "Model",
        protocol,
        baseURL: "https://fixture.invalid",
        routingPortability: "portable" as const,
      },
    }));
    const invocation = (id: string): RoutingInvocation => ({
      capability: "single-attempt-routing-v1",
      workspaceKey: "workspace",
      sessionId: "session",
      turnId: id,
      attemptId: id,
    });
    const reserve = (id: string) =>
      owner.reserve(
        "fixture",
        routes,
        new Request("https://fixture.invalid", { method: "POST" }),
        invocation(id),
      );
    const initial = (await reserve("failed"))!;
    initial.lease.dispatch();
    initial.finish(
      routes[0]!.account,
      new Response("rate", {
        status: 429,
        headers: { "retry-after-ms": "2000", "x-lcode-rate-limit-scope": "key" },
      }),
      false,
    );
    const diagnostic = owner.readDiagnostics("fixture")!;
    assert.equal(diagnostic.owner.lastDecision?.requestedStrategy, "primary-backup");
    assert.equal(diagnostic.recovery[0]!.phase, "cooling");
    assert.deepEqual(owner.readDiagnostics("fixture"), diagnostic);
    now = 2000;
    const probe = (await reserve("probe"))!;
    probe.lease.dispatch();
    const backup = (await reserve("backup"))!;
    backup.lease.dispatch();
    assert.deepEqual([probe.lease.routeId, backup.lease.routeId], ["a", "b"]);
    probe.finish(routes[0]!.account, new Response("ok"), true);
    const before = (await reserve("before-feedback"))!;
    assert.equal(before.lease.routeId, "b");
    before.lease.cancel();
    owner.observeUsage(invocation("probe"), { outcome: "success" });
    const recovered = (await reserve("recovered"))!;
    assert.equal(recovered.lease.routeId, "a");
    recovered.lease.cancel();
    backup.finish(routes[1]!.account, new Response("ok"), true);
    owner.dispose();
  });
