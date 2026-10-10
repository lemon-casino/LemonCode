import assert from "node:assert/strict";
import test from "node:test";
import { createPhysicalRequestAccounting } from "./request-accounting.js";
import type { ModelNetworkStatusEvent } from "./network-status.js";

const event = (id: string, type: string, extra = {}) =>
  ({
    requestId: id,
    type,
    timestamp: "2026-10-10T00:00:00Z",
    querySource: "main_turn",
    ...extra,
  }) as ModelNetworkStatusEvent;
const request = (id: string) => ({ requestId: id, contextWindow: 100, maxOutputTokens: 20 });

test("physical requests deduplicate and include maintenance without double counting cache/reasoning", () => {
  const ledger = createPhysicalRequestAccounting({ maxRequests: 3, maxReservedTokens: 500 });
  ledger.beforeRequest(request("a"));
  ledger.beforeRequest(request("a"));
  ledger.publish(event("a", "model_request_started"));
  ledger.publish(
    event("a", "model_request_completed", {
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 3, cacheReadTokens: 5 },
    }),
  );
  ledger.publish(
    event("a", "model_request_completed", { usage: { inputTokens: 10, outputTokens: 4 } }),
  );
  ledger.beforeRequest(request("b"));
  ledger.publish(event("b", "model_request_started", { querySource: "project_memory_extraction" }));
  ledger.publish(
    event("b", "model_request_completed", {
      querySource: "project_memory_extraction",
      usage: { totalTokens: 9 },
    }),
  );
  const summary = ledger.snapshot();
  assert.equal(summary.reservedTokens, 240);
  assert.equal(summary.totalTokens, 23);
  assert.equal(summary.maintenanceTokens, 9);
  assert.equal(summary.tokenCoverage, "complete");
});

test("failure/missing terminal are incomplete and missing usage never becomes zero", () => {
  const ledger = createPhysicalRequestAccounting({ maxRequests: 3, maxReservedTokens: 500 });
  ledger.beforeRequest(request("a"));
  ledger.publish(event("a", "model_request_started"));
  ledger.beforeRequest(request("b"));
  ledger.publish(event("b", "model_request_started"));
  ledger.publish(event("b", "model_request_failed"));
  assert.equal(ledger.snapshot().totalTokens, null);
  assert.equal(ledger.snapshot().unsettledRequests, 1);
  assert.equal(ledger.snapshot().tokenCoverage, "incomplete");
});

test("budget rejects before invocation, unknown windows fail closed, concurrent reservations cannot oversell", () => {
  let stopped = 0;
  const ledger = createPhysicalRequestAccounting(
    { maxRequests: 2, maxReservedTokens: 200 },
    () => stopped++,
  );
  ledger.beforeRequest(request("a"));
  assert.throws(() => ledger.beforeRequest(request("b")), /benchmark_token_budget/);
  assert.equal(stopped, 1);
  assert.equal(ledger.snapshot().reservedTokens, 120);
  assert.throws(
    () => ledger.beforeRequest({ requestId: "c", maxOutputTokens: 10 }),
    /benchmark_token_budget/,
  );
  const unbounded = createPhysicalRequestAccounting({ maxRequests: 2, maxReservedTokens: 200 });
  assert.throws(
    () => unbounded.beforeRequest({ requestId: "c", maxOutputTokens: 10 }),
    /benchmark_model_bounds_missing/,
  );
});

test("request facts contain no headers or bodies and records are frozen copies", () => {
  const ledger = createPhysicalRequestAccounting({ maxRequests: 1, maxReservedTokens: 200 });
  ledger.beforeRequest(request("a"));
  ledger.publish(
    event("a", "model_request_started", {
      providerId: "fixture-provider",
      modelId: "fixture-model",
      modelCall: {
        reasoning: {
          effectiveState: "enabled",
          effectiveControl: "fixed_level",
          effectiveLevel: "high",
        },
      },
      requestHeaders: { secret: "sensitive" },
    }),
  );
  assert.ok(!JSON.stringify(ledger.snapshot()).includes("sensitive"));
  assert.equal(ledger.snapshot().requests[0]?.modelId, "fixture-model");
  assert.equal(ledger.snapshot().requests[0]?.effectiveReasoningLevel, "high");
  ledger.snapshot().requests.length = 0;
  assert.equal(ledger.snapshot().requests.length, 1);
});

test("seal freezes incomplete facts and rejects late request admission", () => {
  const ledger = createPhysicalRequestAccounting({ maxRequests: 2, maxReservedTokens: 300 });
  ledger.beforeRequest(request("pending"));
  ledger.publish(event("pending", "model_request_started"));
  ledger.seal();
  const frozen = ledger.snapshot();
  ledger.publish(event("pending", "model_request_completed", { usage: { totalTokens: 9 } }));
  assert.deepEqual(ledger.snapshot(), frozen);
  assert.equal(frozen.tokenCoverage, "incomplete");
  assert.throws(() => ledger.beforeRequest(request("late")), /closed/);
});
