import assert from "node:assert/strict";
import test from "node:test";
import { providerAccountQuotaWindowSchema } from "@lcode/shared";
import { normalizeProviderAccountQuota as normalize } from "./providerAccountQuotaNormalization.js";

const now = Date.parse("2026-10-11T04:00:00Z");

test("Google window IDs stay bounded and do not expose rejected model identifiers", () => {
  const result = normalize(
    "antigravity",
    {
      groups: [
        {
          displayName: "Weekly pool ".repeat(12),
          buckets: [{ bucketId: "Weekly bucket ".repeat(11), remainingFraction: 0.5 }],
        },
      ],
      models: { "access_token=private": { quotaInfo: { remainingFraction: 0.25 } } },
    },
    now,
  );
  assert.equal(result.windows.length, 2);
  for (const window of result.windows)
    assert.equal(providerAccountQuotaWindowSchema.safeParse(window).success, true);
  assert.equal(JSON.stringify(result).includes("access_token"), false);
});

test("partial plugin failures retain current known quota and safe subscription dates", () => {
  const result = normalize(
    "minimax-code",
    {
      error: "access_token=private",
      balance: "$3.50",
      plan: "Pro",
      until: "2026-11-01T00:00:00Z",
      renew: "off",
      windows: [{ name: "Monthly", used: 25, amount: 10, limit: 40, unit: "credits" }],
    },
    now,
  );
  assert.equal(result.status, "ready");
  assert.equal(result.partial, true);
  assert.equal(result.balance, "$3.50");
  assert.equal(result.windows[0]?.remaining, 30);
  assert.equal(result.planExpiresAt, "2026-11-01T00:00:00.000Z");
  assert.equal(result.renewal, "off");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(
    normalize("zed", { plan: "Pro", until: "2026-11-01T00:00:00Z" }, now).status,
    "unknown",
  );
  assert.equal(normalize("zed", { error: "failed", plan: "Pro" }, now).status, "error");
});

test("Copilot invalid window resets fall back and token billing never claims request units", () => {
  const result = normalize(
    "copilot",
    {
      copilot_plan: "individual",
      access_type_sku: "free_educational_quota",
      quota_reset_date_utc: "2026-11-01T00:00:00Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          quota_remaining: 200,
          quota_reset_at: 0,
          token_based_billing: true,
        },
      },
    },
    now,
  );
  assert.equal(result.plan, "Education");
  assert.equal(result.windows[0]?.resetAt, "2026-11-01T00:00:00.000Z");
  assert.equal(result.windows[0]?.remaining, 200);
  assert.equal(result.windows[0]?.unit, undefined);
});

test("Copilot unlimited snapshots do not expose placeholder zero amounts", () => {
  const result = normalize(
    "copilot",
    {
      token_based_billing: true,
      quota_snapshots: { chat: { unlimited: true, entitlement: 0, quota_remaining: 0 } },
    },
    now,
  );
  const window = result.windows[0]!;
  assert.equal(window.unlimited, true);
  for (const field of ["used", "remaining", "limit", "usedPercent", "remainingPercent"] as const)
    assert.equal(window[field], undefined, field);
});

test("Antigravity ignores empty or malformed pool entries instead of inventing exhausted quota", () => {
  const result = normalize(
    "antigravity",
    {
      groups: [
        {
          displayName: "Pool",
          buckets: [null, {}, "bad", { remainingFraction: 0.5 }, { window: "weekly" }],
        },
      ],
    },
    now,
  );
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0]?.remainingPercent, 50);
  assert.equal(result.windows[1]?.remainingPercent, 0);
  assert.equal(
    normalize("antigravity", { groups: [{ buckets: [null, {}] }] }, now).status,
    "unknown",
  );
});

test("Codex reset credits retain available counts and expiry without exposing IDs", () => {
  const result = normalize(
    "codex",
    {
      rate_limit_reset_credits: { available_count: 2 },
      spend_control: {
        individual_limit: {
          limit: "50",
          used: "10",
          remaining: "40",
          unit: "credit",
          used_percent: 20,
        },
      },
      resetCredits: {
        available_count: 2,
        credits: [
          { id: "private-credit", status: "available", expires_at: "2026-11-01T00:00:00Z" },
          { id: "private-expired", status: "redeemed", expires_at: "2026-10-01T00:00:00Z" },
        ],
      },
    },
    now,
  );
  assert.equal(result.windows.find((w) => w.id === "reset-credits")?.remaining, 2);
  assert.equal(
    result.windows.find((w) => w.id === "reset-credits")?.expiresAt,
    "2026-11-01T00:00:00.000Z",
  );
  assert.equal(result.windows.find((w) => w.id === "spend-cap")?.limit, 50);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("Google model quota and pool quota remain distinct with partial and missing-fraction semantics", () => {
  const result = normalize(
    "antigravity",
    {
      plan: "AI Pro",
      partial: true,
      models: {
        "gemini-pro": { displayName: "Gemini Pro", quotaInfo: { remainingFraction: 0.5 } },
        "claude-sonnet": {
          displayName: "Claude",
          quotaInfo: { resetTime: "2026-10-12T00:00:00Z" },
        },
        "unknown-model": { displayName: "Unknown" },
      },
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "weekly", window: "weekly", resetTime: "2026-10-12T00:00:00Z" }],
        },
      ],
    },
    now,
  );
  assert.equal(result.partial, true);
  assert.equal(result.plan, "AI Pro");
  assert.equal(result.windows.find((w) => w.modelId === "gemini-pro")?.remainingPercent, 50);
  assert.equal(result.windows.find((w) => w.modelId === "claude-sonnet")?.remainingPercent, 0);
  assert.equal(
    result.windows.some((w) => w.modelId === "unknown-model"),
    false,
  );
  assert.equal(result.windows.find((w) => w.pool === "Gemini Models")?.remainingPercent, 0);
  const gemini = normalize(
    "gemini",
    {
      plan: "Pro",
      buckets: [
        { modelId: "gemini-pro" },
        { modelId: "gemini-pro" },
        { modelId: "gemini-pro_vertex" },
      ],
    },
    now,
  );
  assert.equal(gemini.windows.length, 1);
  assert.equal(gemini.windows[0]?.remainingPercent, undefined);
  assert.equal(gemini.plan, "Pro");
});
