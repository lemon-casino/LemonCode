import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareResponses } from "./openai-request.js";
import { GoogleModels, resolveGoogleProject } from "./google-models.js";
import { record, list } from "./common.js";
import { geminiRequest } from "./google-wire.js";
import { collapseGoogleModels, googleMetadata } from "./google-capabilities.js";
import { ClaudeModels } from "./claude-models.js";
import { catalogMetadata } from "./catalog-metadata.js";

test("Google explicit thinking off is transmitted and adaptive levels match model capabilities", () => {
  assert.equal(
    record(
      record(
        geminiRequest({
          model: "gemini-3.8-flash",
          thinking: { type: "adaptive" },
          output_config: { effort: "max" },
        }).generationConfig,
      ).thinkingConfig,
    ).thinkingLevel,
    "high",
  );
  assert.deepEqual(
    record(
      geminiRequest({ model: "gemini-2.5-flash", thinking: { type: "disabled" } }).generationConfig,
    ).thinkingConfig,
    { includeThoughts: false, thinkingBudget: 0 },
  );
  assert.deepEqual(
    record(
      geminiRequest({ model: "gemini-3.8-flash", thinking: { type: "disabled" } }).generationConfig,
    ).thinkingConfig,
    { includeThoughts: false, thinkingLevel: "low" },
  );
  assert.equal(
    record(
      record(
        geminiRequest({
          model: "gemini-3-pro-preview",
          thinking: { type: "adaptive" },
          output_config: { effort: "medium" },
        }).generationConfig,
      ).thinkingConfig,
    ).thinkingLevel,
    "high",
  );
});

test("Codex keeps supported tiers and replayed web search while API drops hosted tools only", () => {
  const codex = prepareResponses(
    {
      model: "x",
      service_tier: "auto",
      input: [{ type: "web_search_call", id: "w", status: "completed" }],
      reasoning: { effort: "none" },
      include: ["reasoning.encrypted_content"],
    },
    "codex",
  );
  assert.equal(codex.service_tier, undefined);
  assert.equal(codex.parallel_tool_calls, true);
  assert.equal(codex.tool_choice, "auto");
  assert.equal(codex.include, undefined);
  assert.equal(record(list(codex.tools)[0]).external_web_access, false);
  const api = prepareResponses(
    {
      input: [
        { type: "additional_tools", tools: [{ type: "mcp" }, { type: "function", name: "f" }] },
      ],
      tools: [{ type: "file_search" }, { type: "function", name: "f" }],
    },
    "chatgpt-api",
  );
  assert.equal(list(api.tools).length, 1);
  assert.equal(list(record(list(api.input)[0]).tools).length, 1);
});

test("Google onboarding does not mistake a supplied project for established membership", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const result = await resolveGoogleProject(
    { type: "oauth", projectId: "fixture-project" },
    "gemini",
    async (method, body) => {
      calls.push({ method, body });
      return method === "loadCodeAssist"
        ? {
            allowedTiers: [
              {
                id: "standard-tier",
                isDefault: true,
                userDefinedCloudaicompanionProject: true,
                name: "Standard",
              },
            ],
          }
        : { done: true, response: { cloudaicompanionProject: "fixture-project" } };
    },
    new AbortController().signal,
  );
  assert.equal(result.projectReady, true);
  assert.equal(calls[1]?.method, "onboardUser");
  assert.equal(calls[1]?.body.cloudaicompanionProject, "fixture-project");
});

test("Gemini experiments share offered, quota shown and request wire mappings", async () => {
  const models = new GoogleModels("gemini", async (_grant, method) =>
    method === "listExperiments"
      ? {
          flags: [
            { flagId: 45842815, boolValue: true },
            { flagId: 45768879, boolValue: true },
          ],
        }
      : { buckets: [{ modelId: "gemini-3-flash", remainingFraction: 0.4 }] },
  );
  const grant = { type: "oauth" as const, projectId: "fixture" };
  const found = await models.models(grant, new AbortController().signal);
  assert.ok(found.some((m) => m.id === "gemini-3.8-flash"));
  assert.ok(!found.some((m) => m.id.includes("pro")));
  assert.equal(
    await models.wire(grant, "gemini-3.5-flash", new AbortController().signal),
    "gemini-3.8-flash",
  );
  const quota = await models.quota(grant, new AbortController().signal);
  assert.equal(record(list(quota.buckets)[0]).modelId, "gemini-3.8-flash");
});

test("Antigravity tries paid, current and no entitlement and respects picker order", async () => {
  const tiers: unknown[] = [];
  const models = new GoogleModels("antigravity", async (_grant, _method, body) => {
    tiers.push(record(body.entitlement).userTier);
    if (body.entitlement) throw new Error("unavailable tier");
    return {
      models: {
        a: { displayName: "A" },
        b: { displayName: "B", disabled: true },
        "gemini-2.5-pro": {},
      },
      agentModelSorts: [{ groups: [{ modelIds: ["b", "a"] }] }],
    };
  });
  const found = await models.models(
    { type: "oauth", projectId: "p", tier: "current", paidTier: "paid" },
    new AbortController().signal,
  );
  assert.deepEqual(tiers, ["paid", "current", undefined]);
  assert.deepEqual(
    found.map((m) => m.id),
    ["b", "a"],
  );
  assert.equal(found[0]?.images, true);
});

test("Google metadata uses its public context but keeps AG limits and collapses actual variants", () => {
  assert.equal(catalogMetadata({}).inputModalities, undefined);
  assert.equal(catalogMetadata({}).images, undefined);
  assert.deepEqual(catalogMetadata({ modalities: { input: ["text", "image"] } }).inputModalities, [
    "text",
    "image",
  ]);
  assert.equal(catalogMetadata({ limit: { context: 0, output: -1 } }).contextWindow, undefined);
  assert.equal(catalogMetadata({ limit: { context: 0, output: -1 } }).maxOutputTokens, undefined);
  const catalog = {
    google: { models: { "gemini-3.8-flash": { limit: { context: 1048576, output: 65536 } } } },
  };
  assert.equal(googleMetadata("gemini-3.8-flash", "gemini", catalog).contextWindow, 1048576);
  assert.equal(googleMetadata("gemini-3.8-flash", "antigravity", catalog).contextWindow, undefined);
  const base = {
    protocol: "anthropic-messages" as const,
    baseURL: "https://fixture.test",
    images: true,
  };
  const result = collapseGoogleModels([
    { ...base, id: "gemini-3.8-flash-low", name: "Flash (Low)", contextWindow: 250000 },
    { ...base, id: "gemini-3.8-flash-high", name: "Flash (High)", contextWindow: 300000 },
  ]);
  assert.equal(result.models[0]?.id, "gemini-3.8-flash");
  assert.equal(result.models[0]?.contextWindow, 250000);
  assert.deepEqual(
    result.models[0]?.reasoningVariants?.map((v) => v.id),
    ["low", "high"],
  );
  assert.equal(result.wire.get("gemini-3.8-flash")?.get("high"), "gemini-3.8-flash-high");
});

test("Claude public metadata supplies reasoning options and caches a fallback without repeated fetches", async () => {
  let calls = 0;
  const catalog = new ClaudeModels(async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({
      anthropic: {
        models: {
          "claude-fixture": {
            reasoning: true,
            reasoning_options: [{ type: "budget_tokens" }],
            limit: { context: 200000, output: 64000 },
          },
        },
      },
    });
  });
  const result = await catalog.read();
  assert.equal(result.models.find((m) => m.id === "claude-fixture")?.reasoningVariants?.length, 3);
  assert.equal(calls, 1);
  const offline = new ClaudeModels(async () => {
    calls++;
    throw new Error("offline");
  });
  assert.equal((await offline.read()).fallback, true);
  assert.equal((await offline.read()).fallback, true);
  assert.equal(calls, 2);
});
