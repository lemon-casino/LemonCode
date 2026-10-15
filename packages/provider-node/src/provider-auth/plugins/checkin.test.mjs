import assert from "node:assert/strict";
import test from "node:test";
import { checkinWithLoader } from "./checkin.mjs";

test("WorkBuddy checks status before claiming and preserves a real zero reward", async () => {
  const calls = [];
  const result = await checkinWithLoader(
    "workbuddy",
    {
      fetch: async (input) => {
        const request = new Request(input);
        calls.push(new URL(request.url).pathname);
        return Response.json({
          code: 0,
          data:
            calls.length === 1
              ? { active: true, today_checked_in: false }
              : { credit: 0, streak_days: 3 },
        });
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.outcome, "claimed");
  assert.equal(result.credit, 0);
  assert.equal(result.streak, 3);
  assert.deepEqual(
    calls.map((p) => p.split("/").at(-1)),
    ["checkin-activity-status", "daily-checkin"],
  );
});

test("already checked and inactive events never post a claim", async () => {
  for (const [data, outcome] of [
    [{ active: false }, "inactive"],
    [{ active: true, today_checked_in: true }, "done"],
  ]) {
    let calls = 0;
    const result = await checkinWithLoader(
      "workbuddy",
      {
        fetch: async () => {
          calls++;
          return Response.json({ code: 0, data });
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.outcome, outcome);
    assert.equal(calls, 1);
  }
});

test("Trae own-app refusal is terminal and does not disguise itself as a claim", async () => {
  let calls = 0;
  const result = await checkinWithLoader(
    "trae-cn",
    {
      fetch: async () =>
        Response.json(
          ++calls === 1 ? { code: 0, enable: true, checked_in: false } : { code: 9074 },
        ),
    },
    new AbortController().signal,
  );
  assert.deepEqual(result, { outcome: "own-app" });
  assert.equal(calls, 2);
});

test("unsupported channels and cancellation perform no upstream request", async () => {
  const loader = { fetch: () => assert.fail("must not call") };
  assert.deepEqual(await checkinWithLoader("workbuddy-ai", loader, new AbortController().signal), {
    outcome: "unsupported",
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkinWithLoader("workbuddy", loader, controller.signal), {
    name: "AbortError",
  });
});

for (const channel of ["minimax-code", "minimax-code-global"])
  test(`${channel} signs status and claim through the same authenticated loader`, async () => {
    const calls = [],
      signs = [];
    const result = await checkinWithLoader(
      channel,
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          calls.push(request);
          assert.equal(request.headers.get("x-signature"), "fixture-signature");
          return Response.json({
            base_resp: { status_code: 0 },
            data:
              calls.length === 1
                ? { days: [{ is_today: true, status: 2, points: 800, day_no: 2 }] }
                : { claim_result: 1, points: 0, day_no: 2 },
          });
        },
      },
      new AbortController().signal,
      {
        now: 123,
        signMiniMax: (...args) => {
          signs.push(args);
          return { "x-signature": "fixture-signature" };
        },
      },
    );
    assert.deepEqual(result, { outcome: "claimed", credit: 0, streak: 2 });
    assert.deepEqual(signs, [
      [channel, "GET", 123],
      [channel, "POST", 123],
    ]);
    assert.equal(new URL(calls[0].url).searchParams.get("timezone_id"), "Asia/Shanghai");
  });

for (const channel of ["qoder", "qoder-cn"])
  test(`${channel} respects campaign windows, server claimability and partial rewards`, async () => {
    const now = Date.now(),
      until = now + 3600_000,
      calls = [];
    const campaigns = [
      {
        campaignId: "one",
        actionType: "CLAIM_BENEFIT",
        claimStatus: "CLAIMABLE",
        startAt: now - 1,
        endAt: until,
        benefit: { amount: 25 },
      },
      {
        campaignId: "two",
        actionType: "CLAIM_BENEFIT",
        claimStatus: "CLAIMABLE",
        startAt: now - 1,
        endAt: until,
      },
      { campaignId: "invite", actionType: "INVITE", claimStatus: "CLAIMABLE" },
    ];
    const loader = {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request.url);
        if (calls.length === 1) return Response.json({ campaigns });
        return request.url.endsWith("/one/claim")
          ? Response.json({ data: { status: "CLAIMED", benefit: { amount: 25 } } })
          : Response.json({ status: "FAILED" });
      },
    };
    assert.deepEqual(
      await checkinWithLoader(channel, loader, new AbortController().signal, { now }),
      {
        outcome: "failed",
        error: "partial",
        credit: 25,
        validUntil: new Date(until).toISOString(),
      },
    );
    assert.equal(calls.length, 3);
    const expired = { ...campaigns[0], claimStatus: "CLAIMED", endAt: now / 1000 };
    assert.equal(
      (
        await checkinWithLoader(
          channel,
          { fetch: async () => Response.json({ campaigns: [expired] }) },
          new AbortController().signal,
          { now },
        )
      ).outcome,
      "failed",
    );
  });

test("WorkBuddy distinguishes an expired login from app-only check-in refusal", async () => {
  for (const quotaStatus of [200, 401]) {
    let calls = 0;
    const result = await checkinWithLoader(
      "workbuddy",
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          calls++;
          if (calls === 1) return new Response("", { status: 401 });
          assert.equal(new URL(request.url).pathname, "/billing/meter/get-user-resource-summary");
          return Response.json({ code: 0, data: {} }, { status: quotaStatus });
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(
      result,
      quotaStatus === 200
        ? { outcome: "own-app" }
        : { outcome: "failed", error: "sign_in_required" },
    );
  }
});

test("malformed status, captcha and oversized replies never trigger a claim", async () => {
  for (const response of [
    Response.json({}),
    Response.json({ error: "captcha" }, { status: 403 }),
    new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    let calls = 0;
    const result = await checkinWithLoader(
      "workbuddy",
      {
        fetch: async () => {
          calls++;
          return response;
        },
      },
      new AbortController().signal,
    );
    assert.equal(calls, 1);
    assert.ok(["failed", "captcha"].includes(result.outcome));
  }
});

test("Qoder native identity dependency failures are actionable and do not expose vendor text", async () => {
  for (const dependency of [true, false]) {
    const result = await checkinWithLoader(
      "qoder",
      {
        fetch: async () =>
          Response.json(
            {
              error: {
                message: dependency
                  ? "Qoder check-in: device identity runtime not found; fixture-private-detail"
                  : "fixture-private-detail",
              },
            },
            { status: 502 },
          ),
      },
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      outcome: "failed",
      error: dependency ? "dependency_required" : "request_failed",
    });
    assert.doesNotMatch(JSON.stringify(result), /fixture-private-detail/);
  }
});
