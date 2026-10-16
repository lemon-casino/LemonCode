import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAccountScheduler } from "./providerAccountScheduler.js";
import type { ProviderAccountQuotas } from "./providerAccountQuotas.js";
import type { RoutingInvocation } from "@lcode/shared";
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
const invocation = (id: string): RoutingInvocation => ({
  capability: "single-attempt-routing-v1",
  workspaceKey: "workspace",
  sessionId: "session",
  attemptId: id,
  turnId: id,
});
test("HD-01 OAuth reserves shared input/output/total Token windows before dispatch", async () => {
  const owner = new ProviderAccountScheduler(
    async () => ({ version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 }),
    {
      peek: () => ({
        revision: 1,
        value: {
          windows: ["tokens", "input_tokens", "output_tokens"].map((unit) => ({
            id: unit,
            unit,
            scope: "shared",
            quotaPoolId: "team",
            remaining: 100,
            limit: 100,
            kind: "budget",
            stableId: true,
            instanceId: "one",
          })),
        },
      }),
    } as unknown as ProviderAccountQuotas,
  );
  const context = {
    ...invocation("a"),
    tokens: { input: 40, output: 20, total: 60, quality: "bound" as const },
  };
  const a = (await owner.reserve(
    "fixture",
    routes,
    new Request("https://fixture.invalid"),
    context,
  ))!;
  const resources = owner.readDiagnostics("fixture")!.owner.resources;
  assert.equal(resources.find((w) => w.unit === "tokens")!.reserved, 60);
  assert.equal(resources.find((w) => w.unit === "input_tokens")!.reserved, 40);
  assert.equal(resources.find((w) => w.unit === "output_tokens")!.reserved, 20);
  await assert.rejects(
    owner.reserve("fixture", routes, new Request("https://fixture.invalid"), {
      ...context,
      attemptId: "b",
      turnId: "b",
    }),
    /quota-exhausted/,
  );
  a.lease.dispatch();
  a.finish(routes[0]!.account, new Response("ok"), true);
  owner.observeUsage(context, {
    outcome: "success",
    inputTokens: 10,
    outputTokens: 5,
    workUnits: 15,
  });
  assert.equal(
    owner.readDiagnostics("fixture")!.owner.resources.find((w) => w.unit === "tokens")!.held,
    15,
  );
  owner.dispose();
});
test("HD-02 OAuth keeps long running probe feedback past five minutes", async () => {
  let now = 0;
  const owner = new ProviderAccountScheduler(
    async () => ({ version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 }),
    {
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
              instanceId: "one",
            },
          ],
        },
      }),
    } as unknown as ProviderAccountQuotas,
    { now: () => now },
  );
  const reserve = (id: string) =>
    owner.reserve("fixture", routes, new Request("https://fixture.invalid"), invocation(id));
  const first = (await reserve("first"))!;
  first.lease.dispatch();
  first.finish(
    routes[0]!.account,
    new Response("rate", {
      status: 429,
      headers: { "x-lcode-rate-limit-scope": "key", "retry-after-ms": "0" },
    }),
  );
  const probe = (await reserve("probe"))!;
  probe.lease.dispatch();
  now = 300001;
  const backup = (await reserve("backup"))!;
  backup.lease.cancel();
  probe.finish(routes[0]!.account, new Response("ok"), true);
  owner.observeUsage(invocation("probe"), { outcome: "success" });
  const next = (await reserve("next"))!;
  assert.equal(next.lease.routeId, "a");
  next.lease.cancel();
  owner.dispose();
});
