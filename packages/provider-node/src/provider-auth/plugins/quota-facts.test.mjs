import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaFacts } from "./quota-facts.mjs";

async function reading(channel, url, body, output, method = "json") {
  const facts = createQuotaFacts(channel);
  const response = facts.observe(url, Response.json(body));
  await response[method]();
  return facts.apply(output);
}
const window = (name, extra = {}) => ({ name, used: 0, ...extra });

test("Factory and Cline distinguish missing, null, invalid and genuine zero", async () => {
  for (const value of [undefined, null, "invalid", false, -1, 0, 25]) {
    const expected = typeof value === "number" && value >= 0 ? value : undefined;
    const factory = await reading(
      "factory",
      "https://api.factory.ai/api/billing/limits",
      { limits: { standard: { fiveHour: { usedPercent: value } } } },
      { windows: [window("5 hours"), window("Extra usage", { aside: true, display: "$2.00" })] },
      "text",
    );
    assert.equal(factory.windows[0].used, expected);
    assert.equal(factory.windows[1].display, "$2.00");
    const cline = await reading(
      "cline",
      "https://api.cline.bot/api/v1/users/me/plan/usage-limits",
      { success: true, data: { limits: [{ type: "weekly", percentUsed: value }] } },
      { windows: [window("Weekly")], error: "partial fixture", balance: "$3.00" },
      "text",
    );
    assert.equal(cline.windows[0].used, expected);
    assert.equal(cline.error, "partial fixture");
    assert.equal(cline.balance, "$3.00");
  }
});

test("Cursor preserves real pool zero and removes invented On-demand spend", async () => {
  const facts = createQuotaFacts("cursor");
  await facts
    .observe(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      Response.json({ planUsage: { autoPercentUsed: 0, apiPercentUsed: 42 }, spendLimitUsage: {} }),
    )
    .json();
  await facts
    .observe(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
      Response.json({ hardLimit: 20 }),
    )
    .json();
  const output = facts.apply({
    windows: [
      window("Cursor Models", { aside: true }),
      window("Other Models"),
      window("Total"),
      window("On-demand", { display: "$0.00 / $20.00" }),
    ],
  });
  assert.equal(output.windows[0].used, 0);
  assert.equal(output.windows[1].used, 42);
  assert.equal(output.windows[2].used, undefined);
  assert.equal(output.windows[3].used, undefined);
  assert.equal(output.windows[3].display, undefined);
  assert.equal(output.windows[3].limit, 20);
});

test("Cursor explicit unlimited keeps known spend without percentage", async () => {
  const facts = createQuotaFacts("cursor");
  await facts
    .observe(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      Response.json({ planUsage: {}, spendLimitUsage: { individualUsed: 0 } }),
    )
    .json();
  await facts
    .observe(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit",
      Response.json({ hardLimit: 2147483647 }),
    )
    .json();
  const out = facts.apply({ windows: [window("On-demand", { display: "$0.00", aside: true })] });
  assert.equal(out.windows[0].unlimited, true);
  assert.equal(out.windows[0].amount, 0);
  assert.equal(out.windows[0].used, undefined);
});

test("Grok and Kiro retain only reported usage quantities", async () => {
  const grok = await reading(
    "grok",
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    { config: { onDemandCap: { val: 10 } } },
    { windows: [window("Allowance"), window("On-demand"), window("Rate limit", { used: 100 })] },
  );
  assert.equal(grok.windows[0].used, undefined);
  assert.equal(grok.windows[1].used, undefined);
  assert.equal(grok.windows[2].used, 100);
  const kiro = await reading(
    "kiro",
    "https://management.us-east-1.kiro.dev/Get-Usage-Limits?resourceType=CREDIT",
    {
      usageBreakdownList: [
        {
          usageLimitWithPrecision: 100,
          freeTrialInfo: {
            freeTrialStatus: "ACTIVE",
            usageLimitWithPrecision: 20,
            currentUsageWithPrecision: 0,
          },
        },
      ],
    },
    { windows: [window("Free trial"), window("Credits", { display: "0 / 100" })] },
    "text",
  );
  assert.equal(kiro.windows[0].used, 0);
  assert.equal(kiro.windows[1].used, undefined);
  assert.equal(kiro.windows[1].amount, undefined);
  assert.equal(kiro.windows[1].limit, 100);
  assert.equal(kiro.windows[1].display, undefined);
});

test("WorkBuddy aggregate never turns an unreported package into zero", async () => {
  for (const channel of ["workbuddy", "workbuddy-ai"]) {
    const origin =
      channel === "workbuddy" ? "https://copilot.tencent.com" : "https://www.workbuddy.ai";
    const out = await reading(
      channel,
      origin + "/billing/meter/get-user-resource-summary",
      {
        code: 0,
        data: {
          Packages: [
            { CycleTotalCapacity: "10", CycleUsedCapacity: "0" },
            { CycleTotalCapacity: "20" },
          ],
        },
      },
      { windows: [window("Credits", { amount: 0, limit: 30, display: "0 / 30" })] },
      "text",
    );
    assert.equal(out.windows[0].used, undefined);
    assert.equal(out.windows[0].amount, undefined);
    assert.equal(out.windows[0].limit, 30);
    assert.equal(out.windows[0].display, undefined);
  }
});

test("aggregate quotas include every package instead of truncating a total", async () => {
  const out = await reading(
    "workbuddy",
    "https://copilot.tencent.com/billing/meter/get-user-resource-summary",
    {
      data: {
        Packages: Array.from({ length: 101 }, () => ({
          CycleTotalCapacity: "10",
          CycleUsedCapacity: "1",
        })),
      },
    },
    { windows: [window("Credits", { amount: 101, limit: 1010 })] },
    "text",
  );
  assert.equal(out.windows[0].amount, 101);
  assert.equal(out.windows[0].limit, 1010);
});

test("BigModel and ZAI preserve unknown and explicit no-cap across MCP reordering", async () => {
  for (const channel of ["bigmodel", "zai"]) {
    const origin = channel === "bigmodel" ? "https://open.bigmodel.cn" : "https://api.z.ai";
    const out = await reading(
      channel,
      origin + "/api/monitor/usage/quota/limit?type=2",
      {
        code: 200,
        data: {
          limits: [
            { type: "TIME_LIMIT", usage: 0, percentage: 100 },
            { unit: 3, number: 5, usage: 10 },
            { unit: 6, number: 1, usage: 20, remaining: 20 },
          ],
        },
      },
      { windows: [window("5 hours"), window("Weekly"), window("MCP · Month")] },
      "text",
    );
    assert.equal(out.windows[0].used, undefined);
    assert.equal(out.windows[0].limit, 10);
    assert.equal(out.windows[1].used, 0);
    assert.equal(out.windows[2].used, undefined);
    assert.equal(out.windows[2].unlimited, true);
  }
});

test("Trae quantity gaps do not acquire synthetic amount or display", async () => {
  const cn = await reading(
    "trae-cn",
    "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
    {
      user_entitlement_pack_list: [
        { entitlement_base_info: { quota: { credits_limit: 100 } }, usage: {} },
      ],
    },
    { windows: [window("Credits", { amount: 0, limit: 100 })] },
  );
  assert.equal(cn.windows[0].used, undefined);
  assert.equal(cn.windows[0].amount, undefined);
  assert.equal(cn.windows[0].limit, 100);
  const global = await reading(
    "trae-global",
    "https://api-sg-central.trae.ai/trae/api/v1/pay/user_current_entitlement_list",
    {
      user_entitlement_pack_list: [
        {
          entitlement_base_info: { quota: { basic_usage_limit: 10, bonus_usage_limit: 0 } },
          usage: { basic_usage_amount: 0, bonus_usage_amount: 0 },
        },
      ],
    },
    { windows: [window("Dollar Usage")] },
  );
  assert.equal(global.windows[0].used, 0);
  assert.equal(global.windows[0].amount, 0);
});

test("quota facts whitelist endpoints, preserve bodies and remain per-call", async () => {
  const first = createQuotaFacts("factory");
  const second = createQuotaFacts("factory");
  const body = { limits: { standard: { fiveHour: {} } }, privateField: "never-projected" };
  const response = first.observe("https://api.factory.ai/api/billing/limits", Response.json(body));
  assert.deepEqual(await response.clone().json(), body);
  assert.deepEqual(await response.json(), body);
  for (const url of [
    "https://api.factory.ai/api/auth/token",
    "https://unrelated.invalid/api/billing/limits",
  ]) {
    await second.observe(url, Response.json(body)).json();
  }
  const raw = { windows: [window("5 hours")] };
  assert.deepEqual(second.apply(raw), raw);
  const failure = first.observe(
    "https://api.factory.ai/api/billing/limits",
    Response.json({}, { status: 401 }),
  );
  await failure.json();
  const out = first.apply(raw);
  assert.equal(out.windows[0].used, undefined);
  assert.equal(JSON.stringify(out).includes("never-projected"), false);
  assert.equal(createQuotaFacts("devin"), null);
});
