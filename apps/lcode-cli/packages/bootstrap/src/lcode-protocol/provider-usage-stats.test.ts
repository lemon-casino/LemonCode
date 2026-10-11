import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsageQueryInput } from "@lcode/contracts";
import { getProviderUsageStats } from "./provider-usage-stats.js";
import type { LCodeProtocolAgentServerContext } from "./server-types.js";

test("provider usage protocol retains filters and bounds the query interval", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let captured: ProviderUsageQueryInput | undefined;
  const context = {
    deps: {
      sessionStore: {
        queryProviderUsage: async (input: ProviderUsageQueryInput) => {
          captured = input;
          return { source: "fixture" };
        },
      },
    },
  } as unknown as LCodeProtocolAgentServerContext;
  await getProviderUsageStats(context, {
    range: "7d",
    providerId: "oauth:codex",
    connectionId: null,
    modelId: "same-model",
    timeZone: "Asia/Shanghai",
    offset: 25,
    limit: 25,
  });
  assert.deepEqual(captured, {
    range: "7d",
    providerId: "oauth:codex",
    connectionId: null,
    modelId: "same-model",
    timeZone: "Asia/Shanghai",
    offset: 25,
    limit: 25,
    since: now - 7 * 86400000,
    until: now,
  });
  await assert.rejects(getProviderUsageStats(context, { range: "7d", apiKey: "forbidden" }));
  await assert.rejects(getProviderUsageStats(context, { range: "7d", limit: 1000000 }));
  await getProviderUsageStats(context, {
    range: "all",
    providerId: "oauth:antigravity",
    connectionId: "33333333-3333-4333-8333-333333333333",
  });
  assert.equal(captured?.since, 0);
  assert.equal(captured?.until, now);
  assert.equal(captured?.providerId, "oauth:antigravity");
});

test("an unavailable or older usage store cannot be presented as a zero-usage snapshot", async () => {
  const context = { deps: { sessionStore: {} } } as unknown as LCodeProtocolAgentServerContext;
  await assert.rejects(
    getProviderUsageStats(context, { range: "24h" }),
    /provider_usage_unavailable/u,
  );
});
