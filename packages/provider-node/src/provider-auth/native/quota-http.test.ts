import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { OpenAIAuthDriver } from "./openai.js";
import { GoogleAuthDriver } from "./google.js";
import { record } from "./common.js";

function context(extra: Record<string, unknown> = {}): AuthDriverContext {
  let grant: AuthGrant = {
    type: "oauth",
    access: "fixture-only",
    expires: Date.now() + 3600000,
    projectId: "fixture-project",
    projectReady: true,
    tier: "paid",
    plan: "Fixture Plan",
    ...extra,
  };
  return {
    read: async () => grant,
    write: async (next) => {
      grant = next;
    },
  };
}

test("Codex reads reset details only for positive count and retains count on detail failure", async () => {
  for (const mode of ["none", "zero", "details", "failed"] as const) {
    const paths: string[] = [];
    const driver = new OpenAIAuthDriver("codex", async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.method, "GET");
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/usage"))
        return Response.json({
          rate_limit: { primary_window: { used_percent: 20 } },
          ...(mode === "none"
            ? {}
            : { rate_limit_reset_credits: { available_count: mode === "zero" ? 0 : 2 } }),
        });
      return mode === "failed"
        ? new Response(null, { status: 503 })
        : Response.json({
            available_count: 2,
            credits: [
              { id: "fixture-reset", status: "available", expires_at: "2026-11-01T00:00:00Z" },
            ],
          });
    });
    const result = record(await driver.quota(context()));
    assert.equal(paths.length, mode === "none" || mode === "zero" ? 1 : 2);
    assert.equal(result.partial, mode === "failed" ? true : undefined);
    assert.equal(record(result.resetCredits).available_count, mode === "details" ? 2 : undefined);
    if (mode === "failed") assert.equal(record(result.rate_limit_reset_credits).available_count, 2);
    driver.dispose();
  }
});

test("Google quota preserves plan and keeps independently successful Antigravity readings", async () => {
  for (const mode of ["both", "models", "summary", "neither"] as const) {
    const paths: string[] = [];
    const driver = new GoogleAuthDriver("antigravity", async (input, init) => {
      const request = new Request(input, init);
      paths.push(request.url);
      const models = request.url.endsWith(":fetchAvailableModels");
      assert.equal(record(await request.json()).project, "fixture-project");
      if (mode === "neither" || (models ? mode === "summary" : mode === "models"))
        return new Response(null, { status: 503 });
      return Response.json(
        models
          ? { models: { fixture: { quotaInfo: { remainingFraction: 0.5 } } } }
          : {
              groups: [
                {
                  displayName: "Fixture Models",
                  buckets: [{ window: "weekly", remainingFraction: 0.2 }],
                },
              ],
            },
      );
    });
    if (mode === "neither") await assert.rejects(driver.quota(context()), /quota/i);
    else {
      const result = record(await driver.quota(context()));
      assert.equal(result.plan, "Fixture Plan");
      assert.equal(result.models !== undefined, mode !== "summary");
      assert.equal(result.groups !== undefined, mode !== "models");
      assert.equal(result.partial, mode === "both" ? undefined : true);
    }
    assert.equal(paths.length, mode === "summary" || mode === "neither" ? 3 : 2);
    assert.equal(
      paths.some((url) => url.includes("GenerateContent")),
      false,
    );
    driver.dispose();
  }
  const gemini = new GoogleAuthDriver("gemini", async () =>
    Response.json({ buckets: [{ modelId: "fixture", remainingFraction: 0 }] }),
  );
  assert.equal(record(await gemini.quota(context())).plan, "Fixture Plan");
  gemini.dispose();
});

test("quota cancellation must not become partial success", async () => {
  const controller = new AbortController();
  const driver = new GoogleAuthDriver("antigravity", async (input) => {
    if (String(input).includes("fetchAvailableModels")) return Response.json({ models: {} });
    controller.abort();
    throw new Error("cancelled");
  });
  await assert.rejects(driver.quota({ ...context(), signal: controller.signal }));
  driver.dispose();
});
