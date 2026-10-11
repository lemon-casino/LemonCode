import assert from "node:assert/strict";
import test from "node:test";
import { invocationNetworkEvents, modelUsageAttribution } from "./usage-model-attribution.js";
import { SessionEventType } from "@lcode/contracts";
import { recordModelUsageFact } from "./usage-observability.js";
import { persistAssistantMessage } from "./message-persistence.js";

const model = {
  providerId: "oauth:zed",
  modelId: "same-model",
  properties: { contextWindow: 1000 },
} as never;
const trace = { traceId: "trace", spanId: "span-one", sessionId: "session" } as never;
const accountA = "11111111-1111-4111-8111-111111111111";
const accountB = "22222222-2222-4222-8222-222222222222";
function event(type: string, account?: string, spanId = "span-one", sessionId = "session") {
  return {
    type: SessionEventType.ModelNetworkStatus,
    payload: {
      type,
      providerId: "oauth:zed",
      modelId: "same-model",
      traceId: "trace",
      spanId,
      sessionId,
      responseHeaders: account ? { "x-zcode-connection-id": account } : {},
    },
  };
}

test("logical request uses final response account across retries and isolates concurrent tool invocations", () => {
  const events = invocationNetworkEvents({
    model,
    traceContext: trace,
    events: [
      event("model_request_failed", accountA),
      event("model_retry_scheduled"),
      event("model_request_completed", accountB),
      event("model_request_completed", "foreign", "child"),
      event("model_request_completed", "foreign", "span-one", "another-session"),
    ] as never,
  });
  assert.equal(events.length, 3);
  assert.deepEqual(
    modelUsageAttribution(model, events, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      reasoningTokens: 5,
    }),
    {
      authChannelId: "zed",
      accountConnectionId: accountB,
      usageKnown: true,
      contextWindowTokens: 1000,
      contextUsedTokens: 120,
    },
  );
});

test("failure without final response leaves account and tokens unknown, never reuses previous attempt", () => {
  const events = invocationNetworkEvents({
    model,
    traceContext: trace,
    events: [event("model_request_failed", accountA), event("model_request_failed")] as never,
  });
  const facts = modelUsageAttribution(model, events, undefined);
  assert.equal(facts.accountConnectionId, undefined);
  assert.equal(facts.usageKnown, false);
  assert.equal(facts.contextUsedTokens, undefined);
});

test("API calls cannot be labelled OAuth from an upstream header; genuine zero differs from missing usage", () => {
  const api = { providerId: "api", properties: {} } as never;
  assert.equal(
    modelUsageAttribution(api, [event("model_request_completed", "fake").payload] as never, {})
      .authChannelId,
    undefined,
  );
  assert.equal(
    modelUsageAttribution(api, [event("model_request_completed", "fake").payload] as never, {})
      .accountConnectionId,
    undefined,
  );
  assert.equal(
    modelUsageAttribution(model, [], { inputTokens: 0, outputTokens: 0 }).usageKnown,
    true,
  );
  assert.equal(modelUsageAttribution(model, [], {}).usageKnown, false);
  assert.equal(
    modelUsageAttribution(
      model,
      [event("model_request_completed", "not-a-uuid").payload] as never,
      {},
    ).accountConnectionId,
    undefined,
  );
});

test("core writes actual account fields to the existing logical usage record for each tool iteration", async () => {
  const records: Record<string, unknown>[] = [];
  const runtime = {
    sessionId: "session",
    config: {},
    sessionStore: {
      recordModelUsage: async (record: Record<string, unknown>) => {
        records.push(record);
      },
      upsertTurnUsage() {},
      upsertToolUsage() {},
      pruneUsage() {},
    },
  } as never;
  for (const [id, account] of [
    ["assistant-one", accountA],
    ["assistant-two", accountB],
  ]) {
    await recordModelUsageFact(runtime, {
      assistantMessageId: id,
      events: [event("model_request_completed", account)],
      model: {
        providerId: "oauth:zed",
        modelId: "same-model",
        properties: { contextWindow: 1000 },
        options: {},
      },
      networkEventStartIndex: 0,
      querySource: "main_turn",
      result: { usage: { inputTokens: 100, outputTokens: 20 } },
      startedAt: 1,
      status: "completed",
      traceContext: trace,
    } as never);
  }
  assert.deepEqual(
    records.map((record) => [
      record.logicalRequestId,
      record.accountConnectionId,
      record.contextUsedTokens,
      record.usageKnown,
    ]),
    [
      ["assistant-one", accountA, 120, true],
      ["assistant-two", accountB, 120, true],
    ],
  );
});

test("assistant persistence retains frozen invocation capacity instead of current selection", async () => {
  let saved: Record<string, unknown> | undefined;
  const runtime = {
    sessionId: "session",
    config: {},
    sessionStore: {},
    getSessionModelSelection: () => ({ providerId: "switched", modelId: "new" }),
    getPlanEnabled: () => false,
    persistMessage: async (value: Record<string, unknown>) => {
      saved = value;
    },
  } as never;
  await persistAssistantMessage.call(
    runtime,
    "assistant" as never,
    "user" as never,
    1,
    undefined,
    trace,
    model,
  );
  assert.equal(saved?.providerId, "oauth:zed");
  assert.deepEqual(saved?.metadata, { contextWindowTokens: 1000 });
});
