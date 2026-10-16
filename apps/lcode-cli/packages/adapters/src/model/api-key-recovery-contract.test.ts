import assert from "node:assert/strict";
import test from "node:test";
import { RoutingError } from "@lcode/provider";
import { classifyModelFailure } from "./failure-classifier.js";
import { isTlsFailure } from "./failure-tls.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import type { RoutingRequest } from "@lcode/provider";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import { ApiKeyPool } from "./api-key-pool.js";
import { RateLimitWindow } from "@lcode/provider";
import { toAdapterError } from "./runner-retry.js";
import type { ModelStatusContext } from "./runner-status.js";

test("RCD-07 fixed routing errors preserve their safe reason before network or TLS classification", () => {
  for (const reason of [
    "quota-exhausted",
    "quota-owner-unavailable",
    "dispatch-uncertain",
    "route-cooling",
  ] as const) {
    const result = classifyModelFailure(new RoutingError(reason));
    assert.equal(result.routing?.code, reason);
    assert.notEqual(result.reason, "tls_error");
    if (reason === "dispatch-uncertain") assert.equal(result.retryable, false);
  }
  assert.equal(isTlsFailure("dispatch-uncertain"), false);
  assert.equal(isTlsFailure("CERT_HAS_EXPIRED"), true);
  const details = {
    scope: "pool" as const,
    phase: "admission" as const,
    retryAt: Date.now() + 5000,
    dispatch: "unsent" as const,
  };
  assert.deepEqual(classifyModelFailure(new RoutingError("route-cooling", details)).routing, {
    code: "route-cooling",
    ...details,
  });
  const failure = new RoutingError("route-cooling", details);
  assert.deepEqual(
    toAdapterError(
      failure,
      classifyModelFailure(failure),
      {
        traceId: "fixture",
        requestId: "request",
        providerId: "fixture",
        modelId: "model",
        maxAttempts: 1,
      } as ModelStatusContext,
      1,
    ).context?.routing,
    { code: "route-cooling", ...details },
  );
});

test("RCD-03 API binding isolates remote sessions, compatibility options and whitespace identity fallback", async () => {
  const contexts: RoutingRequest[] = [];
  const model = {
    providerId: "fixture",
    modelId: "model",
    providerKind: "openai",
    properties: {},
    acquireApiKeyAttempt: async (_signal: unknown, _outside: unknown, context: RoutingRequest) => {
      contexts.push(context);
      return undefined;
    },
  } as unknown as ResolvedAiSdkModel;
  for (const [remoteSessionId, selectedSpeed, workspaceIdentity] of [
    ["one", "fast", "   "],
    ["two", "fast", undefined],
    ["one", "slow", undefined],
    ["one", "fast", undefined],
  ]) {
    const request = {
      messages: [],
      selectedSpeed,
      traceContext: {
        sessionId: "session",
        turnId: "turn",
        attributes: {
          workspaceIdentity,
          workspacePath: "synthetic-workspace",
          remoteSessionId,
          actorId: "actor",
        },
      },
    } as unknown as AiSdkModelTextRequest;
    await resolveModelForAttempt({ attempt: 1, request, resolveModel: () => model });
  }
  assert.notEqual(contexts[0]!.scopeKey, contexts[1]!.scopeKey);
  assert.notEqual(contexts[0]!.scopeKey, contexts[2]!.scopeKey);
  assert.equal(contexts[0]!.scopeKey, contexts[3]!.scopeKey);
});

test("RCD-05 API expiry admits one half-open Key and waits for normalized success", () => {
  let now = 0;
  const pool = new ApiKeyPool(
    [
      { id: "a", apiKey: "synthetic-a" },
      { id: "b", apiKey: "synthetic-b" },
    ],
    undefined,
    new RateLimitWindow(() => now),
    undefined,
    () => now,
  );
  pool.configureRouting({ version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 });
  pool.observeRoutingQuota({
    keyId: "a",
    windows: [
      {
        resourceId: "requests",
        instanceId: "one",
        revision: 1,
        kind: "rate",
        quality: "fresh",
        remaining: 100,
        limit: 100,
        unit: "requests",
      },
    ],
  });
  const request = (id: string) => ({
    attemptId: id,
    scopeKey: "scope",
    turnId: id,
    modelKey: "model",
    workUnits: 1,
  });
  const first = pool.reserve(request("failed"));
  first.begin!();
  first.observe(429, new Headers({ "retry-after-ms": "2000", "x-lcode-rate-limit-scope": "key" }));
  first.end!(false);
  first.release();
  now = 2000;
  const probe = pool.reserve(request("probe"));
  probe.begin!();
  const backup = pool.reserve(request("backup"));
  backup.begin!();
  assert.deepEqual([probe.key.id, backup.key.id], ["a", "b"]);
  backup.end!(true);
  backup.observeUsage!({ outcome: "success" });
  backup.release();
  probe.end!(true);
  probe.release();
  const beforeFeedback = pool.reserve(request("before-feedback"));
  assert.equal(beforeFeedback.key.id, "b");
  beforeFeedback.release();
  probe.observeUsage!({ outcome: "success" });
  const recovered = pool.reserve(request("recovered"));
  assert.equal(recovered.key.id, "a");
  recovered.release();
  pool.dispose();
});

test("RCD-13 dispersed indexed API routing refreshes cooldown deadlines and probe feedback", () => {
  let now = 0;
  const keys = Array.from({ length: 160 }, (_, index) => ({
    id: String(index),
    apiKey: `synthetic-${index}`,
    routing: { quotaPoolId: `pool-${index}` },
  }));
  const pool = new ApiKeyPool(
    keys,
    undefined,
    new RateLimitWindow(() => now),
    undefined,
    () => now,
  );
  pool.configureRouting({ version: 1, strategy: "primary-backup", maxInFlightPerCandidate: 8 });
  for (const key of keys)
    pool.observeRoutingQuota({
      poolId: key.routing.quotaPoolId,
      windows: [
        {
          resourceId: "requests",
          instanceId: "one",
          revision: 1,
          kind: "rate",
          quality: "fresh",
          remaining: key.id === "0" ? 1000 : 100,
          limit: 1000,
          unit: "requests",
        },
      ],
    });
  const reserve = (attemptId: string) =>
    pool.reserve({
      attemptId,
      scopeKey: "scope",
      turnId: attemptId,
      modelKey: "model",
      workUnits: 1,
    });
  const failed = reserve("failed");
  failed.begin!();
  failed.observe(429, new Headers({ "retry-after-ms": "2000", "x-lcode-rate-limit-scope": "key" }));
  failed.end!(false);
  failed.release();
  const backup = reserve("backup");
  assert.equal(backup.key.id, "1");
  backup.release();
  now = 2000;
  const probe = reserve("probe");
  assert.equal(probe.key.id, "0");
  probe.begin!();
  const concurrent = reserve("concurrent");
  assert.equal(concurrent.key.id, "1");
  concurrent.release();
  probe.end!(true);
  probe.release();
  probe.observeUsage!({ outcome: "success" });
  const restored = reserve("restored");
  assert.equal(restored.key.id, "0");
  restored.release();
  assert.equal(pool.readRoutingDiagnostics({ limit: 1 }).index!.rankBuilds, 1);
  const failedModel = reserve("model-failed");
  failedModel.begin!();
  failedModel.observe(503, new Headers({ "retry-after-ms": "2000" }));
  failedModel.end!(false);
  failedModel.release();
  const other = pool.reserve({
    attemptId: "other-model",
    scopeKey: "scope-other",
    turnId: "other",
    modelKey: "other-model",
    workUnits: 1,
  });
  assert.equal(other.key.id, "0");
  other.begin!();
  other.end!(true);
  other.observeUsage!({ outcome: "success", workUnits: 1 });
  other.release();
  const originalModel = reserve("original-model");
  assert.equal(originalModel.key.id, "1");
  originalModel.release();
  pool.dispose();
});
