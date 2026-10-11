import assert from "node:assert/strict";
import { test } from "node:test";
import { providerAccountQuotaSchema } from "@lcode/shared";
import { normalizeProviderAccountQuota } from "./providerAccountQuotaNormalization.js";

const now = Date.parse("2026-10-11T04:00:00Z");
test("normalizes Codex windows, explicit zero and credits without exposing account data", () => {
  const result = normalizeProviderAccountQuota(
    "codex",
    {
      plan_type: "plus",
      access_token: "private-token",
      account_id: "private-id",
      credits: { balance: "0", has_credits: false },
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18000,
          reset_after_seconds: 3600,
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_at: now / 1000 + 86400,
        },
      },
    },
    now,
  );
  assert.equal(result.status, "ready");
  assert.equal(result.plan, "plus");
  assert.equal(result.balance, "0 credits");
  assert.deepEqual(
    result.windows.map((w) => [w.usedPercent, w.remainingPercent]),
    [
      [25, 75],
      [0, 100],
    ],
  );
  assert.equal(result.windows[0]!.resetAt, "2026-10-11T05:00:00.000Z");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("normalizes Copilot numeric strings and exhausted pooled premium allowance", () => {
  const result = normalizeProviderAccountQuota(
    "copilot",
    {
      copilot_plan: "business",
      quota_reset_date: "2026-11-01",
      quota_snapshots: {
        chat: { unlimited: true, has_quota: false },
        completions: { entitlement: "400", quota_remaining: "300" },
        premium_interactions: { unlimited: true, has_quota: false },
      },
    },
    now,
  );
  assert.equal(result.windows[0]!.unlimited, true);
  assert.equal(result.windows[0]!.usedPercent, undefined);
  assert.equal(result.windows[1]!.used, 100);
  assert.equal(result.windows[1]!.remainingPercent, 75);
  assert.equal(result.windows[2]!.usedPercent, 100);
  assert.equal(result.windows[2]!.unlimited, undefined);
  assert.equal(result.windows[1]!.resetAt, "2026-11-01T00:00:00.000Z");
});

test("normalizes Google model buckets and Antigravity pools, retaining unknown fractions", () => {
  const gemini = normalizeProviderAccountQuota(
    "gemini",
    {
      buckets: [
        { modelId: "gemini-pro", remainingFraction: 0.75, resetTime: "2026-10-12T00:00:00Z" },
        { modelId: "gemini-flash", resetTime: "2026-10-12T00:00:00Z" },
      ],
    },
    now,
  );
  assert.equal(gemini.windows[0]!.usedPercent, 25);
  assert.equal(gemini.windows[1]!.usedPercent, undefined);
  assert.equal(gemini.windows[1]!.remainingPercent, undefined);
  const gravity = normalizeProviderAccountQuota(
    "antigravity",
    {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "p", window: "5h", remainingFraction: 0.5 },
            { bucketId: "w", window: "weekly", remainingFraction: 0.25 },
            { bucketId: "off", window: "weekly", remainingFraction: 1, disabled: true },
          ],
        },
      ],
    },
    now,
  );
  assert.equal(gravity.windows.length, 2);
  assert.equal(gravity.windows[1]!.pool, "Gemini Models");
  assert.equal(gravity.windows[1]!.remainingPercent, 25);
});

test("normalizes every plugin channel's shared usage schema through a bounded whitelist", () => {
  for (const channel of [
    "bigmodel",
    "zai",
    "cline",
    "commandcode-plan",
    "cursor",
    "devin",
    "factory",
    "grok",
    "kiro",
    "minimax-code",
    "minimax-code-global",
    "mimo-app",
    "qoder",
    "qoder-cn",
    "trae-cn",
    "trae-global",
    "workbuddy",
    "workbuddy-ai",
    "zed",
  ]) {
    const result = normalizeProviderAccountQuota(
      channel,
      {
        plan: "Pro",
        user: "private-account",
        balance: "$1.50",
        signIn: "kept",
        metadata: { token: "private-token" },
        windows: [
          {
            name: "Credits",
            used: 25,
            amount: 10,
            limit: 40,
            unit: "credits",
            display: "10 / 40",
            resetSecs: 3600,
            access: "private-token",
          },
        ],
      },
      now,
    );
    assert.equal(result.status, "ready", channel);
    assert.equal(result.windows[0]!.usedPercent, 25, channel);
    assert.equal(result.windows[0]!.used, 10, channel);
    assert.equal(result.windows[0]!.resetAt, "2026-10-11T05:00:00.000Z", channel);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(
      providerAccountQuotaSchema.safeParse({
        connectionId: "test",
        source: "upstream",
        stale: false,
        ...result,
      }).success,
      true,
    );
  }
});

test("distinguishes unsupported, empty, unknown, failed and malformed responses", () => {
  assert.equal(
    normalizeProviderAccountQuota(
      "claude",
      { supported: false, reason: "private", url: "https://private.invalid" },
      now,
    ).status,
    "unsupported",
  );
  assert.equal(
    normalizeProviderAccountQuota("chatgpt-api", { status: "unsupported" }, now).status,
    "unsupported",
  );
  assert.equal(normalizeProviderAccountQuota("zed", { windows: [] }, now).status, "unknown");
  assert.equal(
    normalizeProviderAccountQuota("zed", { plan: "Pro", windows: [] }, now).status,
    "unknown",
  );
  assert.equal(
    normalizeProviderAccountQuota("zed", { windows: [{ name: "Unknown" }] }, now).windows[0]!
      .usedPercent,
    undefined,
  );
  assert.deepEqual(normalizeProviderAccountQuota("zed", { error: "Bearer private-secret" }, now), {
    status: "error",
    windows: [],
    error: "request_failed",
  });
  assert.equal(normalizeProviderAccountQuota("codex", "secret", now).error, "invalid_response");
  const result = normalizeProviderAccountQuota(
    "zed",
    {
      plan: "Bearer private-secret",
      windows: [
        {
          name: "Quota",
          used: NaN,
          amount: Infinity,
          limit: -2,
          resetsAt: "bad",
          display: "access_token=private",
        },
      ],
    },
    now,
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.windows[0]!.usedPercent, undefined);
  assert.equal(result.windows[0]!.limit, undefined);
  assert.equal(result.plan, undefined);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("plugin information rows do not turn placeholder zeros into full allowance", () => {
  for (const [channel, name, display] of [
    ["cline", "Credits", "12 credits used"],
    ["factory", "Extra usage", "$5.00"],
    ["cursor", "On-demand", "$2.00"],
    ["bigmodel", "Gift plans to claim in the ZCode app", "1 · Start Plan"],
  ]) {
    const result = normalizeProviderAccountQuota(
      channel!,
      { windows: [{ name, used: 0, aside: true, display }] },
      now,
    );
    assert.equal(result.status, "ready");
    assert.equal(result.windows[0]!.display, display);
    assert.equal(result.windows[0]!.usedPercent, undefined);
    assert.equal(result.windows[0]!.remainingPercent, undefined);
  }
  for (const [channel, window] of [
    ["cursor", { name: "Total", used: 0, aside: true }],
    ["cursor", { name: "Grok Bot", used: 50, aside: true }],
    ["devin", { name: "ACUs", used: 0, aside: true, display: "0 / 50 ACUs" }],
    ["cline", { name: "Credits", used: 0, amount: 0, limit: 50, aside: true, display: "0 / 50" }],
  ] as const) {
    const result = normalizeProviderAccountQuota(channel, { windows: [window] }, now);
    assert.equal(result.windows[0]!.usedPercent, window.used);
  }
});
