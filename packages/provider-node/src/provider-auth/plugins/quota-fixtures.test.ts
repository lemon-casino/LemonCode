import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { AuthDriver, AuthDriverContext, AuthGrant } from "../driver.js";
import { createPluginAuthFixtureDriver } from "../plugins.js";

interface Quota {
  windows?: {
    name: string;
    used?: number;
    amount?: number;
    limit?: number;
    display?: string;
    unlimited?: boolean;
  }[];
  error?: string;
}
async function fixture(route: (path: string) => unknown | Promise<unknown>) {
  const calls: string[] = [];
  const drivers: AuthDriver[] = [];
  const server = createServer(async (req, res) => {
    calls.push(req.url!);
    for await (const _ of req) {
      /* Consume fixture request. */
    }
    try {
      const value = await route(req.url!);
      res.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(value ?? {}));
    } catch {
      res.writeHead(503).end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    driver(channel: string) {
      const driver = createPluginAuthFixtureDriver(
        channel,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      )!;
      drivers.push(driver);
      return driver;
    },
    async close() {
      await Promise.all(drivers.map((d) => d.dispose?.()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const context = (grant: AuthGrant, signal?: AbortSignal): AuthDriverContext => ({
  read: async () => grant,
  write: async (next) => {
    grant = next;
  },
  signal,
});
const oauth: AuthGrant = {
  type: "oauth",
  access: "fixture-access",
  refresh: "fixture-refresh",
  expires: Date.now() + 3600000,
};

test("actual fixed quota hooks preserve missing values across all affected regional channels", async (t) => {
  const f = await fixture((path) => {
    if (path === "/api/billing/limits")
      return { limits: { standard: { fiveHour: {}, weekly: { usedPercent: 0 } } } };
    if (path.endsWith("/users/me/plan/usage-limits"))
      return {
        success: true,
        data: { limits: [{ type: "five_hour" }, { type: "weekly", percentUsed: 0 }] },
      };
    if (path.endsWith("/users/me")) return { success: true, data: { id: "fixture-user" } };
    if (path.endsWith("/balance")) return { success: true, data: { balance: 0 } };
    if (path.endsWith("/GetCurrentPeriodUsage"))
      return { planUsage: { apiPercentUsed: 0 }, spendLimitUsage: {} };
    if (path.endsWith("/GetHardLimit")) return { hardLimit: 15 };
    if (path.startsWith("/Get-Usage-Limits"))
      return { usageBreakdownList: [{ usageLimitWithPrecision: 100 }] };
    if (path.endsWith("/get-user-resource-summary"))
      return { code: 0, data: { Packages: [{ CycleTotalCapacity: "100" }] } };
    if (path.startsWith("/api/monitor/usage/quota/limit"))
      return {
        code: 0,
        data: {
          limits: [
            { unit: 3, usage: 100 },
            { unit: 6, usage: 0, percentage: 100 },
          ],
        },
      };
    if (path.endsWith("/subscription/list")) return { code: 0, data: [] };
    if (path.endsWith("/ide_user_ent_usage"))
      return {
        user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 100 } } }],
      };
    if (path.endsWith("/user_current_entitlement_list"))
      return {
        user_entitlement_pack_list: [
          { entitlement_base_info: { quota: { basic_usage_limit: 100, bonus_usage_limit: 0 } } },
        ],
      };
  });
  t.after(() => f.close());
  const grants: Record<string, AuthGrant> = {
    factory: { type: "api", key: "fk-fixture" },
    cline: { type: "api", key: "fixture-key" },
    cursor: {
      type: "oauth",
      access:
        "e30." +
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
          "base64url",
        ) +
        ".fixture",
      refresh: "",
      expires: 0,
    },
    kiro: {
      ...oauth,
      profileArn: "arn:aws:codewhisperer:us-east-1:fixture:profile/test",
      method: "social",
    },
    workbuddy: oauth,
    "workbuddy-ai": oauth,
    bigmodel: { type: "api", key: "fixture-key", metadata: { site: "bigmodel" } },
    zai: { type: "api", key: "fixture-key", metadata: { site: "zai" } },
    "trae-cn": oauth,
    "trae-global": oauth,
  };
  for (const [channel, grant] of Object.entries(grants))
    await t.test(channel, async () => {
      const before = f.calls.length;
      const result = (await f.driver(channel).quota!(context(grant))) as Quota;
      assert.equal(result.error, undefined, channel);
      assert.ok(result.windows?.length, channel + " actual windows");
      assert.equal(result.windows[0]!.used, undefined, channel + " unknown must not be zero");
      assert.equal(result.windows[0]!.amount, undefined);
      assert.equal(result.windows[0]!.display, undefined);
      if (channel === "factory" || channel === "cline" || channel === "cursor")
        assert.equal(result.windows[1]!.used, 0);
      if (channel === "bigmodel" || channel === "zai")
        assert.equal(result.windows[1]!.unlimited, true);
      assert.ok(f.calls.length > before);
    });
});

test("Grok actual CLI-profile quota hook retains rate-limit semantics and missing billing facts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-grok-quota-fixture-"));
  const file = join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      fixture: { key: "fixture-key", expires_at: new Date(Date.now() + 3600000).toISOString() },
    }),
  );
  const f = await fixture((path) =>
    path === "/v1/billing?format=credits" ? { config: {} } : undefined,
  );
  t.after(async () => {
    await f.close();
    await unlink(file);
    await rmdir(dir);
  });
  const result = (await f.driver("grok").quota!(context({ ...oauth, refresh: dir }))) as Quota;
  assert.equal(result.error, undefined);
  assert.equal(result.windows?.[0]?.name, "Allowance");
  assert.equal(result.windows?.[0]?.used, undefined);
  assert.deepEqual(f.calls, ["/v1/billing?format=credits"]);
});

test("quota cancellation cannot contaminate concurrent or subsequent calls on the same worker", async (t) => {
  let arrived!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const f = await fixture(async (path) => {
    if (path !== "/api/billing/limits") return;
    const number = ++requests;
    if (number === 1) {
      arrived();
      await barrier;
    }
    return { limits: { standard: { fiveHour: number === 2 ? {} : { usedPercent: 0 } } } };
  });
  t.after(() => f.close());
  const driver = f.driver("factory"),
    grant: AuthGrant = { type: "api", key: "fk-fixture" };
  const controller = new AbortController();
  const cancelled = driver.quota!(context(grant, controller.signal));
  await reached;
  const concurrent = driver.quota!(context(grant));
  controller.abort();
  release();
  await assert.rejects(cancelled, /cancel/i);
  assert.equal(((await concurrent) as Quota).windows?.[0]?.used, undefined);
  assert.equal(((await driver.quota!(context(grant))) as Quota).windows?.[0]?.used, 0);
  assert.equal(requests, 3);
});
